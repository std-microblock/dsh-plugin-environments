//! TCP/UDP tunnels.

use crate::protocol::{Args, OpError, OpResult};
use crate::session::{ChannelHandle, Inbound, Session, ok};
use serde_json::json;
use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::net::{TcpListener, TcpStream, UdpSocket};

async fn resolve(host: &str, port: u16) -> Result<SocketAddr, OpError> {
    let host = if host.is_empty() { "127.0.0.1" } else { host };
    tokio::net::lookup_host((host, port))
        .await?
        .next()
        .ok_or_else(|| OpError::new("ENOENT", format!("cannot resolve {host}")))
}

/// Bridge an established TCP stream with a channel.
fn bridge_tcp(s: &Arc<Session>, stream: TcpStream, mut handle: ChannelHandle) {
    let ch = handle.ch;
    let _ = stream.set_nodelay(true);
    let (mut rd, mut wr) = stream.into_split();
    let sr = s.clone();
    let read_task = tokio::spawn(async move {
        use tokio::io::AsyncReadExt;
        let mut buf = vec![0u8; 64 * 1024];
        loop {
            match rd.read(&mut buf).await {
                Ok(0) => {
                    sr.send_eof(ch, None);
                    break;
                }
                Ok(n) => {
                    if !sr.send_data(ch, None, buf[..n].to_vec()).await {
                        return;
                    }
                }
                Err(e) => {
                    sr.close_channel(ch, None, Some(e.into()));
                    return;
                }
            }
        }
    });
    let read_abort = read_task.abort_handle();
    s.attach_task(ch, read_abort);
    let sw = s.clone();
    let write_task = tokio::spawn(async move {
        use tokio::io::AsyncWriteExt;
        let mut write_closed = false;
        while let Some(ev) = handle.inbound.recv().await {
            match ev {
                Inbound::Data(_, data) => {
                    let n = data.len();
                    if wr.write_all(&data).await.is_err() {
                        sw.close_channel(ch, None, Some(OpError::new("EIO", "connection reset")));
                        return;
                    }
                    sw.grant(ch, None, n);
                }
                Inbound::Eof(_) => {
                    let _ = wr.shutdown().await;
                    write_closed = true;
                }
                Inbound::Close => return,
            }
            let _ = write_closed;
        }
    });
    s.attach_task(ch, write_task.abort_handle());
    // Close the channel once both directions are done.
    let sc = s.clone();
    let closer = tokio::spawn(async move {
        let _ = read_task.await;
        // Remote side finished sending; wait until the client also ends or closes.
        loop {
            if !sc.channel_open(ch) {
                return;
            }
            if write_task.is_finished() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(200)).await;
        }
        sc.close_channel(ch, None, None);
    });
    s.attach_task(ch, closer.abort_handle());
}

fn bridge_udp_connected(s: &Arc<Session>, sock: UdpSocket, mut handle: ChannelHandle) {
    let ch = handle.ch;
    let sock = Arc::new(sock);
    let rs = sock.clone();
    let sr = s.clone();
    let read_task = tokio::spawn(async move {
        let mut buf = vec![0u8; 65536];
        loop {
            match rs.recv(&mut buf).await {
                Ok(n) => {
                    if !sr.send_data(ch, None, buf[..n].to_vec()).await {
                        return;
                    }
                }
                Err(e) => {
                    // ICMP port unreachable surfaces as ConnectionReset on Windows; keep going.
                    if e.kind() == std::io::ErrorKind::ConnectionReset
                        || e.kind() == std::io::ErrorKind::ConnectionRefused
                    {
                        continue;
                    }
                    sr.close_channel(ch, None, Some(e.into()));
                    return;
                }
            }
        }
    });
    s.attach_task(ch, read_task.abort_handle());
    let sw = s.clone();
    let write_task = tokio::spawn(async move {
        while let Some(ev) = handle.inbound.recv().await {
            match ev {
                Inbound::Data(_, data) => {
                    let n = data.len();
                    let _ = sock.send(&data).await;
                    sw.grant(ch, None, n);
                }
                Inbound::Eof(_) => {}
                Inbound::Close => return,
            }
        }
    });
    s.attach_task(ch, write_task.abort_handle());
}

pub async fn connect(s: &Arc<Session>, a: Args<'_>) -> OpResult {
    let host = a.opt_str("host").unwrap_or("127.0.0.1");
    let port = a.u64("port")? as u16;
    let proto = a.opt_str("proto").unwrap_or("tcp");
    let addr = resolve(host, port).await?;
    match proto {
        "tcp" => {
            let stream = tokio::time::timeout(Duration::from_secs(20), TcpStream::connect(addr))
                .await
                .map_err(|_| OpError::new("EIO", format!("connect to {addr} timed out")))??;
            let handle = s.open_channel(&[1], None);
            let ch = handle.ch;
            bridge_tcp(s, stream, handle);
            ok(json!({ "ch": ch }))
        }
        "udp" => {
            let bind: SocketAddr = if addr.is_ipv4() {
                "0.0.0.0:0".parse().unwrap()
            } else {
                "[::]:0".parse().unwrap()
            };
            let sock = UdpSocket::bind(bind).await?;
            sock.connect(addr).await?;
            let handle = s.open_channel(&[1], None);
            let ch = handle.ch;
            bridge_udp_connected(s, sock, handle);
            ok(json!({ "ch": ch }))
        }
        other => Err(OpError::invalid(format!("unknown proto `{other}`"))),
    }
}

pub async fn listen(s: &Arc<Session>, a: Args<'_>) -> OpResult {
    let host = a.opt_str("host").unwrap_or("127.0.0.1");
    let port = a.opt_u64("port").unwrap_or(0) as u16;
    let proto = a.opt_str("proto").unwrap_or("tcp");
    let addr = resolve(host, port).await?;
    let id = s.alloc_id();
    match proto {
        "tcp" => {
            let listener = TcpListener::bind(addr).await?;
            let actual = listener.local_addr()?.port();
            let sl = s.clone();
            let task = tokio::spawn(async move {
                loop {
                    let Ok((stream, peer)) = listener.accept().await else {
                        break;
                    };
                    let ch = sl.alloc_id();
                    let handle = sl.open_channel_with_id(ch, &[1], None, Some(id));
                    sl.send_json(
                        json!({"t":"accept","listener":id,"ch":ch,"peer":peer.to_string()}),
                    );
                    bridge_tcp(&sl, stream, handle);
                }
            });
            s.add_listener(id, task.abort_handle());
            ok(json!({ "id": id, "port": actual }))
        }
        "udp" => {
            let sock = Arc::new(UdpSocket::bind(addr).await?);
            let actual = sock.local_addr()?.port();
            let sl = s.clone();
            let task = tokio::spawn(async move {
                let mut peers: HashMap<SocketAddr, (u64, Instant)> = HashMap::new();
                let mut buf = vec![0u8; 65536];
                loop {
                    let r = tokio::time::timeout(Duration::from_secs(10), sock.recv_from(&mut buf))
                        .await;
                    let now = Instant::now();
                    peers.retain(|_, (ch, last)| {
                        let alive = sl.channel_open(*ch)
                            && now.duration_since(*last) < Duration::from_secs(120);
                        if !alive {
                            sl.close_channel(*ch, None, None);
                        }
                        alive
                    });
                    let (n, peer) = match r {
                        Ok(Ok(v)) => v,
                        Ok(Err(e)) if e.kind() == std::io::ErrorKind::ConnectionReset => continue,
                        Ok(Err(_)) => break,
                        Err(_) => continue,
                    };
                    let ch = match peers.get_mut(&peer) {
                        Some((ch, last)) => {
                            *last = now;
                            *ch
                        }
                        None => {
                            let ch = sl.alloc_id();
                            let mut handle = sl.open_channel_with_id(ch, &[1], None, Some(id));
                            sl.send_json(
                                json!({"t":"accept","listener":id,"ch":ch,"peer":peer.to_string()}),
                            );
                            let ws = sock.clone();
                            let sw = sl.clone();
                            let writer = tokio::spawn(async move {
                                while let Some(ev) = handle.inbound.recv().await {
                                    match ev {
                                        Inbound::Data(_, data) => {
                                            let n = data.len();
                                            let _ = ws.send_to(&data, peer).await;
                                            sw.grant(ch, None, n);
                                        }
                                        Inbound::Eof(_) => {}
                                        Inbound::Close => return,
                                    }
                                }
                            });
                            sl.attach_task(ch, writer.abort_handle());
                            peers.insert(peer, (ch, now));
                            ch
                        }
                    };
                    let data = buf[..n].to_vec();
                    let sd = sl.clone();
                    // Never block the receive loop on one slow peer's window.
                    tokio::spawn(async move {
                        sd.send_data(ch, None, data).await;
                    });
                }
            });
            s.add_listener(id, task.abort_handle());
            ok(json!({ "id": id, "port": actual }))
        }
        other => Err(OpError::invalid(format!("unknown proto `{other}`"))),
    }
}
