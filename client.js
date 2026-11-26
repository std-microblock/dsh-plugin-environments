window.__ModuleLoader__.load({
	id: "dsh-plugin-environments",
	factory(require) {
		const module = { exports: {} };
		(function (module, exports, require) {
"use strict";var Qn=Object.create;var Ae=Object.defineProperty;var es=Object.getOwnPropertyDescriptor;var ns=Object.getOwnPropertyNames;var ss=Object.getPrototypeOf,ts=Object.prototype.hasOwnProperty;var os=(e,n)=>{for(var t in n)Ae(e,t,{get:n[t],enumerable:!0})},dn=(e,n,t,r)=>{if(n&&typeof n=="object"||typeof n=="function")for(let i of ns(n))!ts.call(e,i)&&i!==t&&Ae(e,i,{get:()=>n[i],enumerable:!(r=es(n,i))||r.enumerable});return e};var ie=(e,n,t)=>(t=e!=null?Qn(ss(e)):{},dn(n||!e||!e.__esModule?Ae(t,"default",{value:e,enumerable:!0}):t,e)),as=e=>dn(Ae({},"__esModule",{value:!0}),e);var Gs={};os(Gs,{apply:()=>_s,inject:()=>qs});module.exports=as(Gs);var Pe=ie(require("react"),1),Ge=require("react");var G=require("react"),is="api/environments",Je=class extends Error{code;constructor(n,t){super(n),this.code=t}};async function E(e,n={},t){let r=await fetch(is,{method:"POST",credentials:"same-origin",cache:"no-store",headers:{"content-type":"application/json"},body:JSON.stringify({action:e,...n}),...t?{signal:t}:{}}),i;try{i=await r.json()}catch{throw new Error(`HTTP ${r.status}`)}if(!i.ok)throw new Je(i.error??`HTTP ${r.status}`,i.code);return i.value}function H(e){return e instanceof Error?e.message:String(e)}var ze=new Set;function O(){for(let e of ze)e()}function ln(e){return ze.add(e),()=>{ze.delete(e)}}function cn(e){return e instanceof Error&&/unknown action/i.test(e.message)}function Le(e,{intervalMs:n=4e3,discover:t=!1}={}){let[r,i]=(0,G.useState)({data:void 0,error:void 0,loading:!0}),[p,o]=(0,G.useState)(0),d=(0,G.useCallback)(()=>o(u=>u+1),[]),a=(0,G.useRef)(!0);return(0,G.useEffect)(()=>(ze.add(d),()=>{ze.delete(d)}),[d]),(0,G.useEffect)(()=>{let u=!1,y,m=new AbortController,I=async()=>{try{let c=await E("state",{sessionId:e,discover:t&&a.current},m.signal);a.current=!1,u||i({data:c,error:void 0,loading:!1})}catch(c){if(u||m.signal.aborted)return;i(f=>({...f,error:H(c),loading:!1}))}u||(y=setTimeout(()=>{document.visibilityState==="visible"?I():y=setTimeout(()=>{I()},n)},n))};return I(),()=>{u=!0,m.abort(),clearTimeout(y)}},[e,p,n,t]),{...r,refresh:d}}function ke(){let[e,n]=(0,G.useState)(!1),[t,r]=(0,G.useState)(void 0),i=(0,G.useRef)(!0);(0,G.useEffect)(()=>()=>{i.current=!1},[]);let p=(0,G.useCallback)(async o=>{n(!0),r(void 0);try{let d=await o();return O(),d}catch(d){i.current&&r(H(d));return}finally{i.current&&n(!1)}},[]);return{busy:e,error:t,run:p,clearError:()=>r(void 0)}}var pn="workspace:";function vn(e){return e?.startsWith(pn)&&e.slice(pn.length)||void 0}function un(e){if(!e)return"";let n=/^[A-Za-z]:[\\/]|^\\\\/.test(e),t=e.replace(/\\/g,"/").replace(/\/+$/,"");return n?t.toLowerCase():t}function mn(e){return e==="offline"||e==="error"}function fn(e,n){let t=[];for(let o of n){let d=e.remoteWorkspaces.find(a=>a.workspaceId!==void 0&&a.workspaceId===o.workspaceId||!!o.path&&un(a.hostPath)===un(o.path));d&&t.push({workspaceId:o.workspaceId,path:o.path??d.hostPath,kind:"remote",envId:d.envId,remoteRoot:d.root,remoteWorkspace:{id:d.id,title:d.title}})}let r={},i=e.discovered.adb.filter(o=>!!o&&typeof o=="object"),p=[];for(let o of new Set(t.flatMap(d=>d.envId?[d.envId]:[]))){let d=e.environments.find(a=>a.id===o);if(!d){r[o]={state:"error",reason:`unknown environment "${o}"`};continue}if(p.push({id:d.id,name:d.name,kind:d.kind}),d.kind==="local")r[o]={state:"available"};else if(d.kind==="adb"&&!e.discovered.adbError){let a=i.find(u=>u.serial===d.config.serial);r[o]=a?.state==="device"?{state:"available"}:{state:"offline",reason:a?`device is ${String(a.state)}`:"device not connected"}}else r[o]={state:d.status?.busy?"busy":"unknown"}}return{bindings:t,availability:r,environments:p}}function Ye(e){let n=new Map;for(let t of e?.bindings??[])t.workspaceId&&n.set(t.workspaceId,t);return n}function hn(e){return e.map(n=>`${n.workspaceId}\0${n.path??""}`).join("")}var xn=1e4,Be=class{snapshot={supported:void 0,view:void 0,byId:new Map,error:void 0};listeners=new Set;workspaces=[];key="";timer;inflight;stopInvalidate;seq=0;subscribe=n=>(this.listeners.add(n),this.listeners.size===1&&this.start(),()=>{this.listeners.delete(n),this.listeners.size===0&&this.stop()});getSnapshot=()=>this.snapshot;setWorkspaces(n){let t=hn(n);t!==this.key&&(this.key=t,this.workspaces=[...n],this.listeners.size>0&&this.refresh())}refresh=()=>{clearTimeout(this.timer),this.inflight?.abort();let n=new AbortController;this.inflight=n;let t=++this.seq;this.load(n.signal).then(r=>{t===this.seq&&this.set(r)},r=>{t===this.seq&&!n.signal.aborted&&this.set({...this.snapshot,error:H(r)})}).finally(()=>{t!==this.seq||this.listeners.size===0||(this.timer=setTimeout(()=>{typeof document>"u"||document.visibilityState==="visible"?this.refresh():this.timer=setTimeout(this.refresh,xn)},xn))})};async load(n){let t=this.workspaces;if(t.length===0)return{...this.snapshot,view:{bindings:[],availability:{},environments:[]},byId:new Map};if(this.snapshot.supported!==!1)try{let p=await E("workspace.bindings",{workspaces:t},n);return{supported:!0,view:p,byId:Ye(p),error:void 0}}catch(p){if(!cn(p))throw p}let r=await E("state",{},n),i=fn(r,t);return{supported:!1,view:i,byId:Ye(i),error:void 0}}set(n){this.snapshot=n;for(let t of this.listeners)t()}start(){this.stopInvalidate=ln(this.refresh),this.refresh()}stop(){this.stopInvalidate?.(),this.stopInvalidate=void 0,clearTimeout(this.timer),this.inflight?.abort(),this.seq++}};var x=ie(require("react"),1),Q=require("react"),Pn=require("react-dom");var N=ie(require("react"),1),j=require("react"),Ie=require("@deepseek-ai/dsh-client-ui-primitives");function rs(e){let n=String(e).split(/[\\/]+/).filter(Boolean);return n[n.length-1]??e}function $e(e){let n=e.pathText.trim();return n&&n!==e.currentDir?{load:n}:e.currentDir?{path:e.currentDir}:{}}function bn(e){if(e.busy||e.loading)return!0;let n=$e(e);return!n.path&&!n.load}function Xe(e,n){return!e||!n?"":`${rs(e)} @ ${n}`}var b=ie(require("react"),1),ds={width:20,height:20,viewBox:"0 0 24 24",fill:"none",stroke:"currentColor",strokeWidth:1.6,strokeLinecap:"round",strokeLinejoin:"round"};function V({size:e=20,children:n,...t}){return b.createElement("svg",{...ds,width:e,height:e,"aria-hidden":"true",...t},n)}function wn({size:e}){return b.createElement(V,{size:e},b.createElement("rect",{x:"3",y:"4",width:"12",height:"9",rx:"1.6"}),b.createElement("path",{d:"M7 17h4M9 13v4"}),b.createElement("rect",{x:"16",y:"9",width:"5",height:"11",rx:"1.4"}),b.createElement("path",{d:"M18 17.5h1"}))}function Ze({size:e}){return b.createElement(V,{size:e},b.createElement("rect",{x:"3",y:"4",width:"18",height:"12",rx:"2"}),b.createElement("path",{d:"M8 20h8M12 16v4"}))}function He({size:e}){return b.createElement(V,{size:e},b.createElement("rect",{x:"3",y:"4",width:"18",height:"7",rx:"1.8"}),b.createElement("rect",{x:"3",y:"13",width:"18",height:"7",rx:"1.8"}),b.createElement("path",{d:"M7 7.5h.01M7 16.5h.01M11 7.5h6M11 16.5h6"}))}function ls({size:e}){return b.createElement(V,{size:e},b.createElement("rect",{x:"3",y:"4",width:"18",height:"16",rx:"2.2"}),b.createElement("path",{d:"m7 9 3 3-3 3M12.5 15H17"}))}function cs({size:e}){return b.createElement(V,{size:e},b.createElement("rect",{x:"6.5",y:"2.5",width:"11",height:"19",rx:"2.4"}),b.createElement("path",{d:"M10.5 18.5h3"}))}function ps({size:e}){return b.createElement(V,{size:e},b.createElement("path",{d:"M4 5.5 11 4.4V11H4zM13 4.1 20 3v8h-7zM4 13h7v6.6L4 18.5zM13 13h7v8l-7-1.1z"}))}function Se({size:e}){return b.createElement(V,{size:e},b.createElement("path",{d:"M3 7.2A2.2 2.2 0 0 1 5.2 5h3.6l2 2.2h8A2.2 2.2 0 0 1 21 9.4v7.4A2.2 2.2 0 0 1 18.8 19H5.2A2.2 2.2 0 0 1 3 16.8z"}))}function yn({size:e}){return b.createElement(V,{size:e},b.createElement("path",{d:"M7 3h7l4 4v12.5A1.5 1.5 0 0 1 16.5 21h-9A1.5 1.5 0 0 1 6 19.5v-15A1.5 1.5 0 0 1 7.5 3z"}),b.createElement("path",{d:"M14 3v4h4"}))}function he({size:e}){return b.createElement(V,{size:e},b.createElement("path",{d:"M12 5v14M5 12h14"}))}function Ne({size:e}){return b.createElement(V,{size:e},b.createElement("path",{d:"M20 11a8 8 0 0 0-14.6-4M4 4v4h4M4 13a8 8 0 0 0 14.6 4M20 20v-4h-4"}))}function Qe({size:e}){return b.createElement(V,{size:e},b.createElement("path",{d:"M4 7h16M10 11v6M14 11v6M6 7l1 12.2A2 2 0 0 0 9 21h6a2 2 0 0 0 2-1.8L18 7M9 7V4.8A.8.8 0 0 1 9.8 4h4.4a.8.8 0 0 1 .8.8V7"}))}function kn({size:e}){return b.createElement(V,{size:e},b.createElement("path",{d:"m14.5 5.5 4 4M4 20l1-4.5L16.3 4.2a1.7 1.7 0 0 1 2.4 0l1.1 1.1a1.7 1.7 0 0 1 0 2.4L8.5 19z"}))}function Sn({size:e}){return b.createElement(V,{size:e},b.createElement("path",{d:"M9 3v5M15 3v5M7 8h10v3a5 5 0 0 1-10 0zM12 16v5"}))}function Nn({size:e}){return b.createElement(V,{size:e},b.createElement("path",{d:"M3 5h18v11H3zM9 20h6M12 16v4"}))}function In({size:e}){return b.createElement(V,{size:e},b.createElement("path",{d:"M12 19V6M6 11l6-6 6 6"}))}function Cn({size:e}){return b.createElement(V,{size:e},b.createElement("path",{d:"m4 11 8-7 8 7M6 10v9h12v-9"}))}function Fe({size:e}){return b.createElement(V,{size:e},b.createElement("path",{d:"m9 6 6 6-6 6"}))}function re({size:e}){return b.createElement(V,{size:e},b.createElement("path",{d:"m5 12.5 4.5 4.5L19 7.5"}))}function Tn({size:e}){return b.createElement(V,{size:e},b.createElement("path",{d:"M3 5h18v11H3zM9 20h6M12 16v4"}),b.createElement("path",{d:"m10 8 4.5 1.6-2 .7-.7 2z"}))}function zn({size:e}){return b.createElement(V,{size:e},b.createElement("path",{d:"M7 3h14v9",strokeDasharray:"2 2.2"}),b.createElement("path",{d:"M3 7h14v9H3zM7 20h6M10 16v4"}))}function Ke({size:e}){return b.createElement(V,{size:e},b.createElement("path",{d:"M3 5h18v11H3zM9 20h6M12 16v4"}),b.createElement("circle",{cx:"12",cy:"9",r:"1.8"}),b.createElement("path",{d:"M9 13.4a3.2 3.2 0 0 1 6 0"}))}function L({size:e}){return b.createElement(V,{size:e,className:"envx-spin"},b.createElement("path",{d:"M12 3a9 9 0 1 0 9 9"}))}function us({size:e}){return b.createElement(V,{size:e},b.createElement("path",{d:"M4 8h13M13 4l4 4-4 4M20 16H7M11 12l-4 4 4 4"}))}function Rn({size:e}){return b.createElement(V,{size:e},b.createElement("rect",{x:"9",y:"9",width:"11",height:"11",rx:"2"}),b.createElement("path",{d:"M5 15V6a2 2 0 0 1 2-2h8"}))}function En({size:e}){return b.createElement(V,{size:e},b.createElement("path",{d:"M3 12h17M15 7l5 5-5 5"}))}function Oe({size:e}){return b.createElement(V,{size:e},b.createElement("circle",{cx:"8",cy:"15",r:"4"}),b.createElement("path",{d:"m11 12 8.5-8.5M16 7l2.5 2.5M14 9l2 2"}))}var gn={local:Ze,server:He,ssh:ls,adb:cs,winuser:ps,reverse:us};function Z({kind:e,size:n=20}){let t=(e!==void 0&&Object.hasOwn(gn,e)?gn[e]:void 0)??He;return b.createElement(t,{size:n})}function se(e,n){return e?e.builtin&&e.kind==="local"?n("env.builtinLocal"):e.name:""}function vs(e){return e==null?"":e<1024?`${e} B`:e<1024*1024?`${(e/1024).toFixed(1)} KB`:e<1024*1024*1024?`${(e/1024/1024).toFixed(1)} MB`:`${(e/1024/1024/1024).toFixed(2)} GB`}function je({open:e,mode:n="workspace",environments:t,initialEnvId:r,initialPath:i,onClose:p,onPicked:o,onCreated:d,t:a}){let[u,y]=(0,j.useState)(r),[m,I]=(0,j.useState)(void 0),[c,f]=(0,j.useState)(!1),[C,R]=(0,j.useState)(void 0),[k,w]=(0,j.useState)(""),[h,z]=(0,j.useState)(""),[$,T]=(0,j.useState)(!1),[v,D]=(0,j.useState)(!1),[te,ee]=(0,j.useState)(void 0),oe=(0,j.useRef)(0),W=(0,j.useCallback)(async(S,q)=>{if(!S)return;let _=++oe.current;f(!0),R(void 0);try{let ae=await E("fs.list",{envId:S,path:q});return _!==oe.current?void 0:(I(ae),w(ae.path),ae)}catch(ae){_===oe.current&&R(H(ae));return}finally{_===oe.current&&f(!1)}},[]);(0,j.useEffect)(()=>{if(!e)return;let S=r??t[0]?.id;y(S),I(void 0),z(""),T(!1),ee(void 0),W(S,i)},[e,r,i]);let be=t.find(S=>S.id===u),X=m?.path,ne=Xe(k.trim()||X,be?.name),ue=$?h:ne,ge=bn({busy:v,loading:c,pathText:k,currentDir:X}),Me=$e({pathText:k,currentDir:X}),Ce=Me.load??Me.path,Te=S=>{y(S),I(void 0),W(S,void 0)},we=S=>{let q=m?.sep??"/",_=X??"";return _.endsWith(q)?`${_}${S}`:`${_}${q}${S}`},De=async()=>{let S=(te??"").trim();if(!S){ee(void 0);return}try{await E("fs.mkdir",{envId:u,path:we(S)}),ee(void 0),W(u,we(S))}catch(q){R(H(q))}},Ve=async S=>{if(!(!u||v)){D(!0),R(void 0);try{let q=$e({pathText:k,currentDir:X}),_=q.path;if(q.load){let We=await W(u,q.load);if(!We)return;_=We.path}if(!_)return;if(n==="pick"){o?.({envId:u,path:_});return}let ae=await E("remoteWorkspace.create",{envId:u,root:_,title:$?h:Xe(_,be?.name)});O(),d?.(ae,S)}catch(q){R(H(q))}finally{D(!1)}}},ye=(m?.entries??[]).filter(S=>S.type==="dir"),U=(m?.entries??[]).filter(S=>S.type!=="dir"),fe=N.createElement("div",{className:"envx-footer"},n==="workspace"&&N.createElement("input",{className:"envx-input",style:{flex:1,minWidth:0},value:ue,placeholder:a("browser.workspaceName"),"aria-label":a("browser.workspaceName"),onChange:S=>{z(S.target.value),T(!0)}}),n!=="workspace"&&N.createElement("span",{className:"envx-spacer"}),N.createElement(Ie.Button,{variant:"ghost",onClick:p},a("action.cancel")),n==="workspace"&&N.createElement(Ie.Button,{variant:"outline",disabled:ge,onClick:()=>{Ve(!1)}},a("browser.create")),N.createElement(Ie.Button,{variant:"primary",disabled:ge,onClick:()=>{Ve(!0)}},a(n==="workspace"?"browser.createAndOpen":"action.choose")));return N.createElement(Ie.Modal,{open:e,onClose:p,title:a(n==="workspace"?"browser.title.workspace":"browser.title"),closeLabel:a("action.close"),footer:fe,className:"envx-dialog-wide"},N.createElement("div",{className:"envx-browser"},N.createElement("div",{className:"envx-browser-bar"},N.createElement("select",{className:"envx-input",value:u??"","aria-label":a("browser.env"),onChange:S=>Te(S.target.value)},t.map(S=>N.createElement("option",{key:S.id,value:S.id},se(S,a)))),N.createElement("div",{className:"envx-crumbs"},N.createElement("input",{value:k,"aria-label":a("browser.path"),spellCheck:!1,onChange:S=>w(S.target.value),onKeyDown:S=>{S.key==="Enter"&&W(u,k.trim()||void 0)}})),N.createElement("button",{type:"button",className:"envx-iconbtn",title:a("action.up"),"aria-label":a("action.up"),disabled:!m?.parent||c,onClick:()=>{W(u,m?.parent)}},N.createElement(In,{size:16})),N.createElement("button",{type:"button",className:"envx-iconbtn",title:a("action.home"),"aria-label":a("action.home"),disabled:!m?.home||c,onClick:()=>{W(u,m?.home)}},N.createElement(Cn,{size:16})),N.createElement("button",{type:"button",className:"envx-iconbtn",title:a("action.newFolder"),"aria-label":a("action.newFolder"),disabled:!X||c,onClick:()=>ee("")},N.createElement(he,{size:16})),N.createElement("button",{type:"button",className:"envx-iconbtn",title:a("action.refresh"),"aria-label":a("action.refresh"),disabled:c,onClick:()=>{W(u,X)}},N.createElement(Ne,{size:16})),c&&N.createElement("span",{className:"envx-browser-busy",title:a("browser.loading"),"aria-label":a("browser.loading")},N.createElement(L,{size:14}))),N.createElement("div",{className:"envx-browser-frame"},N.createElement("div",{className:"envx-browser-list",role:"list","aria-busy":c||void 0},c&&!m&&N.createElement("div",{className:"envx-browser-state"},N.createElement(L,{size:16}),a("browser.loading")),C&&N.createElement("div",{className:"envx-browser-state",style:{color:"var(--dsw-alias-state-error-primary)",flexDirection:"column"}},N.createElement("span",null,C),N.createElement("button",{type:"button",className:"envx-textbtn",onClick:()=>{W(u,Ce)}},a("action.retry"))),!C&&m&&N.createElement(N.Fragment,null,te!==void 0&&N.createElement("div",{className:"envx-entry","data-type":"dir"},N.createElement(Se,{size:16}),N.createElement("input",{className:"envx-input",style:{height:26},autoFocus:!0,value:te,placeholder:a("browser.folderName"),onChange:S=>ee(S.target.value),onKeyDown:S=>{S.key==="Enter"&&De(),S.key==="Escape"&&(S.stopPropagation(),ee(void 0))},onBlur:()=>{De()}})),ye.map(S=>N.createElement("button",{type:"button",key:`d:${S.name}`,className:"envx-entry","data-type":"dir",disabled:c,onClick:()=>{W(u,we(S.name))}},N.createElement(Se,{size:16}),N.createElement("span",null,S.name))),U.map(S=>N.createElement("div",{key:`f:${S.name}`,className:"envx-entry","data-type":"file"},N.createElement(yn,{size:16}),N.createElement("span",null,S.name),N.createElement("em",null,vs(S.size)))),ye.length===0&&U.length===0&&te===void 0&&N.createElement("div",{className:"envx-browser-state"},a("browser.empty")))),c&&m&&N.createElement("div",{className:"envx-browser-overlay"},N.createElement(L,{size:16}),a("browser.loading")))))}function ms({anchor:e,onClose:n,children:t}){let r=(0,Q.useRef)(null),[i,p]=(0,Q.useState)(void 0);return(0,Q.useLayoutEffect)(()=>{let o=()=>{let a=e.getBoundingClientRect(),u=r.current,y=u?.offsetHeight??320,m=u?.offsetWidth??340,c=a.top-8-y>=8?a.top-8-y:Math.min(window.innerHeight-y-8,a.bottom+8),f=Math.max(8,Math.min(window.innerWidth-m-8,a.left));p({top:Math.max(8,c),left:f})};o();let d=new ResizeObserver(o);return r.current&&d.observe(r.current),window.addEventListener("resize",o),()=>{d.disconnect(),window.removeEventListener("resize",o)}},[e]),(0,Q.useEffect)(()=>{let o=a=>{let u=a.target;r.current?.contains(u)||e.contains(u)||u?.closest?.("[role=dialog],[data-envx-keep]")||n()},d=a=>{a.key==="Escape"&&n()};return document.addEventListener("pointerdown",o,!0),document.addEventListener("keydown",d),()=>{document.removeEventListener("pointerdown",o,!0),document.removeEventListener("keydown",d)}},[e,n]),(0,Pn.createPortal)(x.createElement("div",{ref:r,className:"envx-pop",role:"dialog",style:i?{top:i.top,left:i.left}:{visibility:"hidden",top:0,left:0}},t),document.body)}function fs({sessionId:e,data:n,t,openManager:r,onClose:i}){let[p,o]=(0,Q.useState)(void 0),d=ke(),a=ke(),[u,y]=(0,Q.useState)(!1),m=n.environments,I=Object.fromEntries(m.map(v=>[v.id,v])),c=n.session,f=c?.mount,C=f?I[f.envId]:void 0,R=!!c?.started,k=!R&&!f?.inherited&&f?.source!=="workspace",w=new Set(c?.borrowable??[]),h=m.filter(v=>v.borrowable!==!1),z=v=>t(v?"mode.gui":"mode.headless"),$=v=>{let D=new Set(w);D.has(v)?D.delete(v):D.add(v),d.run(()=>E("session.set",{sessionId:e,borrowable:[...D],cwd:c?.cwd}))},T=c?.borrowableSource==="session"?t("pop.borrow.custom"):c?.borrowableSource==="workspace"?t("pop.borrow.inherit.workspace"):t("pop.borrow.inherit.all");return x.createElement(x.Fragment,null,x.createElement("div",{className:"envx-pop-section"},x.createElement("div",{className:"envx-pop-title"},x.createElement("span",null,t("pop.mount")),f?.source==="workspace"&&!f.inherited&&x.createElement("small",null,t("pop.mount.fromWorkspace")),f?.inherited&&x.createElement("small",null,t("pop.mount.inherited"))),x.createElement("p",{className:"envx-pop-hint"},t(R?"pop.mount.locked":"pop.mount.hint")),(!f||k)&&x.createElement("div",{className:"envx-pop-item","data-kind":"local","data-click":k&&f?"":void 0,role:k?"radio":void 0,"aria-checked":k?!f:void 0,tabIndex:k&&f?0:void 0,onClick:()=>{k&&f&&d.run(()=>E("session.set",{sessionId:e,mount:null,cwd:c?.cwd}))}},x.createElement("span",{className:"envx-check","data-on":f?void 0:""},x.createElement(re,{size:12})),x.createElement("span",{className:"envx-tile","data-kind":"local"},x.createElement(Z,{kind:"local",size:15})),x.createElement("div",{className:"envx-pop-item-main"},x.createElement("strong",null,t("pop.host")),x.createElement("span",null,t("pop.host.desc")))),f&&x.createElement("div",{className:"envx-pop-item","data-kind":C?.kind??"server"},x.createElement("span",{className:"envx-check","data-on":""},x.createElement(re,{size:12})),x.createElement("span",{className:"envx-tile","data-kind":C?.kind??"server"},x.createElement(Z,{kind:C?.kind,size:15})),x.createElement("div",{className:"envx-pop-item-main"},x.createElement("strong",null,C?se(C,t):f.envId),x.createElement("span",{title:c.mountActive?.remoteRoot??f.remoteRoot},c.mountActive?.remoteRoot??f.remoteRoot??"",c.mountActive?` \xB7 ${z(c.mountActive.gui)}`:"",!c.mountActive&&!c.mountError?` \xB7 ${t("pop.mount.pending")}`:"")),k&&x.createElement("button",{type:"button",className:"envx-textbtn","data-quiet":"",onClick:()=>o({envId:f.envId})},t("pop.mount.pick"))),k&&m.filter(v=>v.id!==f?.envId).map(v=>x.createElement("div",{key:v.id,className:"envx-pop-item","data-click":"","data-kind":v.kind,role:"radio","aria-checked":!1,tabIndex:0,onClick:()=>o({envId:v.id}),onKeyDown:D=>{(D.key===" "||D.key==="Enter")&&(D.preventDefault(),o({envId:v.id}))}},x.createElement("span",{className:"envx-check"}),x.createElement("span",{className:"envx-tile","data-kind":v.kind},x.createElement(Z,{kind:v.kind,size:15})),x.createElement("div",{className:"envx-pop-item-main"},x.createElement("strong",null,se(v,t)),x.createElement("span",null,t(`kind.${v.kind}`)," \xB7 ",z(v.effectiveMountMode==="gui"))))),(c?.mountBlocked??c?.mountError)&&x.createElement("div",{className:"envx-error-line",style:{marginTop:6},role:"alert"},c.mountBlocked??t("pop.mount.error",{message:c.mountError??""})),c?.mountBlocked&&x.createElement(x.Fragment,null,x.createElement("p",{className:"envx-pop-hint"},t("pop.mount.blocked")),x.createElement("div",{className:"envx-pop-foot"},x.createElement("button",{type:"button",className:"envx-textbtn",disabled:a.busy,onClick:()=>{a.run(()=>E("session.remount",{sessionId:e}).finally(O))}},a.busy?x.createElement(L,{size:13}):t("action.remount"))))),x.createElement("div",{className:"envx-pop-section"},x.createElement("div",{className:"envx-pop-title"},x.createElement("span",null,t("pop.borrow")),x.createElement("small",null,T)),x.createElement("p",{className:"envx-pop-hint"},t("pop.borrow.hint")),h.map(v=>{let D=(c?.held??[]).find(W=>W.envId===v.id&&!W.attached),te=v.status?.busy&&!D,ee=v.status?.gui&&!D?.gui&&!(c?.mountActive?.gui&&f?.envId===v.id),oe=v.status?.gui?.title??v.status?.gui?.sessionId?.slice(0,8)??"";return x.createElement("div",{key:v.id,className:"envx-pop-item","data-click":"","data-kind":v.kind,role:"checkbox","aria-checked":w.has(v.id),tabIndex:0,onClick:()=>$(v.id),onKeyDown:W=>{(W.key===" "||W.key==="Enter")&&(W.preventDefault(),$(v.id))}},x.createElement("span",{className:"envx-check","data-on":w.has(v.id)?"":void 0},x.createElement(re,{size:12})),x.createElement("span",{className:"envx-tile","data-kind":v.kind},x.createElement(Z,{kind:v.kind,size:15})),x.createElement("div",{className:"envx-pop-item-main"},x.createElement("strong",null,se(v,t)),x.createElement("span",null,D?`${t("badge.borrow")} \xB7 ${D.alias} \xB7 ${z(D.gui)}`:te?t("status.busy"):ee?t("status.guiBy",{who:oe}):`${t(`kind.${v.kind}`)}${v.description&&v.description!==v.name?` \xB7 ${v.description}`:""}`)),D&&x.createElement("button",{type:"button",className:"envx-textbtn",onClick:W=>{W.stopPropagation(),d.run(()=>E("lease.release",{leaseId:D.id}))}},t("action.return")))}),x.createElement("div",{className:"envx-pop-foot"},c?.borrowableSource==="session"&&x.createElement("button",{type:"button",className:"envx-textbtn","data-quiet":"",onClick:()=>{d.run(()=>E("session.set",{sessionId:e,borrowable:null}))}},t("pop.borrow.reset")),c?.cwd&&c.borrowableSource==="workspace"&&x.createElement("button",{type:"button",className:"envx-textbtn","data-quiet":"",onClick:()=>{d.run(()=>E("workspace.set",{workspacePath:c.cwd,borrowable:null}))}},t("pop.borrow.clearWorkspace")),c?.cwd&&c.borrowableSource==="session"&&x.createElement("button",{type:"button",className:"envx-textbtn","data-quiet":"",onClick:()=>{d.run(async()=>{await E("workspace.set",{workspacePath:c.cwd,borrowable:[...w]}),y(!0),setTimeout(()=>y(!1),2e3)})}},t(u?"pop.borrow.saved":"pop.borrow.saveWorkspace")),x.createElement("span",{style:{flex:1}}),x.createElement("button",{type:"button",className:"envx-textbtn",onClick:()=>{i(),r()}},t("action.manage"))),d.error&&x.createElement("div",{className:"envx-error-line",style:{marginTop:6}},d.error)),x.createElement(je,{open:!!p,mode:"pick",environments:m,initialEnvId:p?.envId,onClose:()=>o(void 0),onPicked:({envId:v,path:D})=>{o(void 0),d.run(()=>E("session.set",{sessionId:e,mount:{envId:v,remoteRoot:D},cwd:c?.cwd}))},t}))}function Mn({sessionId:e,t:n,openManager:t}){let[r,i]=(0,Q.useState)(!1),p=(0,Q.useRef)(null),{data:o}=Le(e,{intervalMs:r?2500:8e3}),d=o?.session,a=d?.mount,u=a?o?.environments.find(R=>R.id===a.envId):void 0,y=u?se(u,n):a?.envId??"",m=d?.held.filter(R=>!R.attached).length??0,I=d?.mountBlocked,c=!!d?.mountActive?.gui,f=a?y:n("chip.host"),C=[I??(a?n("chip.mounted",{name:y}):n("chip.host.title")),a&&d?.mountActive?n(c?"mode.gui":"mode.headless"):void 0,m?n("chip.borrowed",{count:m}):void 0].filter(Boolean).join(" \xB7 ");return(0,Q.useEffect)(()=>{r&&O()},[r]),x.createElement(x.Fragment,null,x.createElement("button",{ref:p,type:"button",className:"envx-chipbtn","data-active":a&&!I?"":void 0,"data-error":I?"":void 0,"aria-expanded":r,"aria-haspopup":"dialog",title:C,onClick:()=>i(R=>!R)},x.createElement(Z,{kind:a?u?.kind??"server":"local",size:16}),x.createElement("span",null,f),c&&x.createElement("em",null,n("mode.gui")),I&&x.createElement("i",{"aria-hidden":"true"}),m>0&&x.createElement("b",null,m)),r&&p.current&&x.createElement(ms,{anchor:p.current,onClose:()=>i(!1)},o?x.createElement(fs,{sessionId:e,data:o,t:n,openManager:t,onClose:()=>i(!1)}):x.createElement("div",{className:"envx-pop-section"},x.createElement(L,{size:16}))))}var xe="environments",hs={panel:"\u73AF\u5883","page.title":"\u73AF\u5883","page.subtitle":"\u8BA9\u667A\u80FD\u4F53\u4F7F\u7528\u5176\u4ED6\u8BBE\u5907\uFF1A\u6302\u8F7D\u4E3A\u5DE5\u4F5C\u533A\uFF0C\u6216\u5728\u9700\u8981\u65F6\u501F\u7528\u3002","action.refresh":"\u5237\u65B0","action.add":"\u6DFB\u52A0\u73AF\u5883","action.test":"\u6D4B\u8BD5\u8FDE\u63A5","action.testing":"\u8FDE\u63A5\u4E2D\u2026","action.edit":"\u7F16\u8F91","action.delete":"\u5220\u9664","action.cancel":"\u53D6\u6D88","action.save":"\u4FDD\u5B58","action.saveAndTest":"\u4FDD\u5B58\u5E76\u6D4B\u8BD5","action.close":"\u5173\u95ED","action.viewDesktop":"\u67E5\u770B\u684C\u9762","session.title":"\u72EC\u7ACB\u4F1A\u8BDD\u6A21\u5F0F","session.purpose":"\u8BA9\u6BCF\u4E2A Windows \u8D26\u6237\u767B\u5F55\u5230\u81EA\u5DF1\u7684\u4F1A\u8BDD\uFF1A\u6709\u72EC\u7ACB\u7684\u9F20\u6807\u6307\u9488\u548C\u771F\u5B9E\u952E\u9F20\u8F93\u5165\uFF0C\u4E0D\u4F1A\u548C\u4F60\u62A2\u9F20\u6807\uFF0C\u4E5F\u4E0D\u4F1A\u51FA\u73B0\u5728\u4F60\u7684\u5C4F\u5E55\u4E0A\u3002","session.probing":"\u6B63\u5728\u68C0\u6D4B\u672C\u673A\u2026","session.badge.probing":"\u68C0\u6D4B\u4E2D","session.badge.ready":"\u5DF2\u5C31\u7EEA","session.badge.setup":"\u9700\u8981\u8BBE\u7F6E","session.badge.reboot":"\u5F85\u91CD\u542F","session.badge.error":"\u68C0\u6D4B\u5931\u8D25","session.line.ready":"\u9009\u62E9\u300C\u72EC\u7ACB\u4F1A\u8BDD\u300D\u7684\u8D26\u6237\u4F1A\u767B\u5F55\u5230\u81EA\u5DF1\u7684 Windows \u4F1A\u8BDD\u3002","session.line.install.home":"Windows \u5BB6\u5EAD\u7248\u4E0D\u80FD\u6258\u7BA1\u8FDC\u7A0B\u684C\u9762\u4F1A\u8BDD\uFF0C\u5B89\u88C5 TermWrap \u8865\u4E01\u540E\u5373\u53EF\u4F7F\u7528\u3002","session.line.install.client":"\u672C\u673A\u7684 Windows \u7248\u672C\u540C\u4E00\u65F6\u95F4\u53EA\u5141\u8BB8\u4E00\u4E2A\u4F1A\u8BDD\uFF0C\u5B89\u88C5 TermWrap \u8865\u4E01\u540E\u5373\u53EF\u4F7F\u7528\u3002","session.line.enable":"Server \u7248\u539F\u751F\u652F\u6301\u591A\u4F1A\u8BDD\uFF0C\u53EA\u9700\u5F00\u542F\u8FDC\u7A0B\u684C\u9762\u4E3B\u673A\u3002","session.line.reboot":"TermWrap \u5DF2\u5B89\u88C5\uFF0C\u4F46\u670D\u52A1\u6CA1\u80FD\u81EA\u52A8\u91CD\u8F7D\uFF1B\u91CD\u542F\u7535\u8111\u540E\u751F\u6548\u3002","session.line.manual":"\u8FD9\u4E2A\u6784\u5EFA\u6CA1\u6709\u9644\u5E26 TermWrap\uFF0C\u8BF7\u6309 docs/session-mode.md \u624B\u52A8\u5B89\u88C5\u540E\u91CD\u542F\u3002","session.line.unsupported":"\u53EA\u6709 Windows \u4E3B\u673A\u652F\u6301\u72EC\u7ACB\u4F1A\u8BDD\u3002","session.line.error":"\u65E0\u6CD5\u68C0\u6D4B\uFF1A{message}","session.check.termwrap":"TermWrap \u591A\u4F1A\u8BDD\u8865\u4E01","session.check.rdp":"\u8FDC\u7A0B\u684C\u9762\u4E3B\u673A\u5DF2\u5F00\u542F","session.check.rfxvmt":"rfxvmt.dll \u7EC4\u4EF6","session.check.group":"Remote Desktop Users \u7EC4","session.check.service":"Terminal Services \u6B63\u5728\u8FD0\u884C","session.check.listener":"3389 \u7AEF\u53E3\u6B63\u5728\u76D1\u542C","session.action.install":"\u5B89\u88C5 TermWrap","session.action.enable":"\u5F00\u542F\u8FDC\u7A0B\u684C\u9762","session.action.recheck":"\u91CD\u65B0\u68C0\u6D4B","session.action.details":"\u8BE6\u60C5","session.action.hide":"\u6536\u8D77","session.working":"\u5904\u7406\u4E2D\u2026","session.note.admin":"\u9700\u8981\u7BA1\u7406\u5458\u6388\u6743\uFF0C\u901A\u5E38\u4E0D\u7528\u91CD\u542F\u3002","session.note.adminReboot":"\u9700\u8981\u7BA1\u7406\u5458\u6388\u6743\uFF1B\u5B8C\u6210\u540E\u4F1A\u81EA\u52A8\u91CD\u542F\u8FDC\u7A0B\u684C\u9762\u670D\u52A1\uFF0C\u4E0D\u9700\u8981\u91CD\u542F\u7535\u8111\u3002","session.install.detail":"\u968F\u5305 TermWrap {version}\uFF08MIT \u8BB8\u53EF\uFF0C{files} \u4E2A\u6587\u4EF6\uFF0C\u5B89\u88C5\u65F6\u4E0D\u8054\u7F51\uFF09\u3002\u5B89\u88C5\u4F1A\u628A %ProgramFiles%\\RDP Wrapper \u52A0\u5165 Defender \u6392\u9664\u9879\u3001\u628A Terminal Services \u7684\u670D\u52A1 DLL \u6307\u5411\u5B83\u3001\u5F00\u542F\u8FDC\u7A0B\u684C\u9762\uFF0C\u7136\u540E\u81EA\u52A8\u91CD\u542F\u8BE5\u670D\u52A1\u8BA9\u8865\u4E01\u7ACB\u5373\u751F\u6548\uFF08\u53EA\u6709\u91CD\u542F\u670D\u52A1\u5931\u8D25\u65F6\u624D\u9700\u8981\u91CD\u542F\u7535\u8111\uFF09\u3002","session.enable.detail":"\u4F1A\u5F00\u542F\u8FDC\u7A0B\u684C\u9762\u4E3B\u673A\uFF08fDenyTSConnections=0\uFF09\u5E76\u542F\u52A8 Terminal Services\u3002","session.ready.detail":"\u672C\u673A\u53EF\u4EE5\u4E3A\u6BCF\u4E2A\u8D26\u6237\u6258\u7BA1\u72EC\u7ACB\u7684 Windows \u4F1A\u8BDD\u3002","session.edition":"\u7CFB\u7EDF\u7248\u672C\uFF1A{edition}\u3002","session.done.enable":"\u5DF2\u5F00\u542F\u3002\u5982\u679C\u72B6\u6001\u6CA1\u6709\u53D8\u5316\uFF0C\u70B9\u300C\u91CD\u65B0\u68C0\u6D4B\u300D\u3002","session.done.install":"\u5DF2\u5B89\u88C5\u5E76\u751F\u6548\uFF0C\u4E0D\u9700\u8981\u91CD\u542F\u7535\u8111\u3002","session.done.installReboot":"\u5DF2\u5B89\u88C5\uFF0C\u4F46\u8FDC\u7A0B\u684C\u9762\u670D\u52A1\u6CA1\u80FD\u81EA\u52A8\u91CD\u8F7D\uFF1B\u8BF7\u91CD\u542F\u7535\u8111\u3002","action.pause":"\u6682\u505C","action.resume":"\u7EE7\u7EED","desktop.title":"{{name}} \u7684\u684C\u9762","desktop.mode.shared":"\u5171\u7528\u684C\u9762","desktop.mode.private":"\u72EC\u7ACB\u684C\u9762","desktop.mode.session":"\u72EC\u7ACB\u4F1A\u8BDD","desktop.mode.shared.desc":"\u7A0B\u5E8F\u663E\u793A\u5728\u4F60\u7684\u5C4F\u5E55\u4E0A\uFF0C\u4E0E\u4F60\u5171\u7528\u9F20\u6807\u952E\u76D8","desktop.mode.private.desc":"\u5728\u9690\u85CF\u7684\u684C\u9762\u91CC\u8FD0\u884C\uFF0C\u53EF\u901A\u8FC7\u300C\u67E5\u770B\u684C\u9762\u300D\u89C2\u770B","desktop.mode.session.desc":"\u767B\u5F55\u5230\u81EA\u5DF1\u7684 Windows \u4F1A\u8BDD\uFF0C\u6709\u72EC\u7ACB\u6307\u9488\u548C\u771F\u5B9E\u8F93\u5165","desktop.mode.session.notReady":"\u4E5F\u53EF\u4EE5\u5148\u4FDD\u5B58\uFF0C\u8BBE\u7F6E\u5B8C\u6210\u540E\u5373\u53EF\u8FDE\u63A5\u3002","desktop.card.notReady":"\u672C\u673A\u8FD8\u4E0D\u80FD\u6258\u7BA1\u72EC\u7ACB\u4F1A\u8BDD\uFF0C\u6682\u65F6\u65E0\u6CD5\u8FDE\u63A5\u3002","desktop.card.setup":"\u53BB\u8BBE\u7F6E","desktop.saved.notReady":"\u5DF2\u4FDD\u5B58\u3002\u672C\u673A\u5B8C\u6210\u72EC\u7ACB\u4F1A\u8BDD\u8BBE\u7F6E\u540E\u5373\u53EF\u8FDE\u63A5\u3002","desktop.size":"{{w}}\xD7{{h}}","desktop.fps":"{{fps}} fps","desktop.connecting":"\u6B63\u5728\u83B7\u53D6\u753B\u9762\u2026","desktop.hint":"\u8FD9\u662F\u8BE5\u73AF\u5883\u5F53\u524D\u684C\u9762\u7684\u5B9E\u65F6\u753B\u9762\uFF08\u7EA6\u6BCF\u79D2 4 \u5E27\uFF0C\u5DF2\u7F29\u5C0F\uFF09\u3002\u72EC\u7ACB\u684C\u9762\u4E0A\u7684\u7A97\u53E3\u4E0D\u4F1A\u51FA\u73B0\u5728\u4F60\u81EA\u5DF1\u7684\u684C\u9762\u4E0A\u3002","action.newWorkspace":"\u65B0\u5EFA\u8FDC\u7A0B\u5DE5\u4F5C\u533A","action.browse":"\u6D4F\u89C8\u6587\u4EF6","action.release":"\u91CA\u653E","action.return":"\u5F52\u8FD8","action.newSession":"\u65B0\u4F1A\u8BDD","action.remove":"\u79FB\u9664","action.addDevice":"\u6DFB\u52A0\u5230\u5217\u8868","action.create":"\u521B\u5EFA","action.manage":"\u7BA1\u7406\u73AF\u5883\u2026","action.apply":"\u5E94\u7528","action.unmount":"\u53D6\u6D88\u6302\u8F7D","action.choose":"\u9009\u62E9\u6B64\u76EE\u5F55","action.up":"\u4E0A\u4E00\u7EA7","action.home":"\u4E3B\u76EE\u5F55","action.newFolder":"\u65B0\u5EFA\u6587\u4EF6\u5939","action.open":"\u6253\u5F00","action.retry":"\u91CD\u8BD5","action.done":"\u5B8C\u6210","action.copy":"\u590D\u5236","action.copied":"\u5DF2\u590D\u5236","action.saveAndGenerate":"\u4FDD\u5B58\u5E76\u751F\u6210\u547D\u4EE4","kind.local":"\u672C\u673A\u8FDB\u7A0B","kind.server":"\u73AF\u5883\u670D\u52A1\u5668","kind.ssh":"SSH","kind.adb":"Android (ADB)","kind.winuser":"Windows \u8D26\u6237","kind.reverse":"\u73AF\u5883\u670D\u52A1\u5668\uFF08\u53CD\u5411\uFF09","kind.local.desc":"\u5728\u8FD0\u884C dsh \u7684\u7535\u8111\u4E0A\u5355\u72EC\u542F\u52A8\u7684 dsh-env-server \u8FDB\u7A0B","kind.server.desc":"\u8FD0\u884C dsh-env-server \u7684\u673A\u5668\uFF0C\u53EF\u4EE5\u76F4\u8FDE\uFF0C\u4E5F\u53EF\u4EE5\u8BA9\u5B83\u53CD\u5411\u8FDE\u5165","kind.ssh.desc":"\u901A\u8FC7 SSH \u8FDE\u63A5\u670D\u52A1\u5668","kind.adb.desc":"\u771F\u673A\u6216\u6A21\u62DF\u5668\uFF0C\u901A\u8FC7 adb \u63A7\u5236","kind.winuser.desc":"\u672C\u673A\u4E0A\u7684\u53D7\u9650\u6D4B\u8BD5\u8D26\u6237\uFF0C\u53EF\u8FD0\u884C\u56FE\u5F62\u754C\u9762\u7A0B\u5E8F","kind.reverse.desc":"\u7531\u76EE\u6807\u673A\u5668\u4E3B\u52A8\u8FDE\u63A5\u8FC7\u6765\uFF08\u76EE\u6807\u673A\u5668\u6CA1\u6709\u516C\u7F51\u5730\u5740\u65F6\u4F7F\u7528\uFF09","section.environments":"\u73AF\u5883","section.workspaces":"\u8FDC\u7A0B\u5DE5\u4F5C\u533A","section.workspaces.hint":"\u8FDC\u7A0B\u5DE5\u4F5C\u533A\u91CC\u7684\u4F1A\u8BDD\u4F1A\u76F4\u63A5\u5728\u8BE5\u73AF\u5883\u4E2D\u8BFB\u5199\u6587\u4EF6\u3001\u6267\u884C\u547D\u4EE4\u3002","section.workspaces.empty":"\u8FD8\u6CA1\u6709\u8FDC\u7A0B\u5DE5\u4F5C\u533A\u3002\u5728\u4EFB\u610F\u73AF\u5883\u5361\u7247\u4E0A\u9009\u62E9\u201C\u65B0\u5EFA\u8FDC\u7A0B\u5DE5\u4F5C\u533A\u201D\u3002","section.leases":"\u4F7F\u7528\u4E2D","section.leases.empty":"\u5F53\u524D\u6CA1\u6709\u4F1A\u8BDD\u5728\u4F7F\u7528\u73AF\u5883\u3002","section.accounts":"Windows \u6D4B\u8BD5\u8D26\u6237","section.accounts.hint":"\u53D7\u9650\u7684\u672C\u5730\u6807\u51C6\u8D26\u6237\u3002\u4EE5\u5B83\u8FD0\u884C\u7684\u7A0B\u5E8F\u663E\u793A\u5728\u5F53\u524D\u684C\u9762\u4E0A\uFF0C\u4FBF\u4E8E\u667A\u80FD\u4F53\u8FDB\u884C\u754C\u9762\u6D4B\u8BD5\u3002\u521B\u5EFA\u548C\u5220\u9664\u9700\u8981\u7BA1\u7406\u5458\u786E\u8BA4\u3002","section.accounts.empty":"\u8FD8\u6CA1\u6709\u6D4B\u8BD5\u8D26\u6237\u3002","status.available":"\u7A7A\u95F2","status.busy":"\u4F7F\u7528\u4E2D","status.busyBy":"{who} \u4F7F\u7528\u4E2D","status.queue":"{count} \u4E2A\u4F1A\u8BDD\u6392\u961F","status.offline":"\u79BB\u7EBF","status.unknown":"\u672A\u68C0\u6D4B","status.connected":"\u53EF\u8FDE\u63A5 \xB7 {ms} ms","status.failed":"\u8FDE\u63A5\u5931\u8D25","status.discovered":"\u81EA\u52A8\u53D1\u73B0","status.builtin":"\u5185\u7F6E","status.shared":"\u65E0\u754C\u9762\u53EF\u5E76\u884C","status.exclusive":"\u72EC\u5360","status.guiBy":"GUI\uFF1A{who}","badge.mount":"\u6302\u8F7D","badge.borrow":"\u501F\u7528","field.name":"\u540D\u79F0","field.name.ph":"\u4F8B\u5982\uFF1A\u6D4B\u8BD5\u673A Pixel 8","field.id":"\u6807\u8BC6","field.id.hint":'\u667A\u80FD\u4F53\u501F\u7528\u540E\u7528\u5B83\u6307\u5B9A\u5728\u54EA\u53F0\u673A\u5668\u4E0A\u6267\u884C\uFF0C\u4F8B\u5982 environment: "{alias}"',"field.description":"\u5907\u6CE8","field.host":"\u4E3B\u673A","field.port":"\u7AEF\u53E3","field.token":"\u4EE4\u724C","field.token.hint":"\u670D\u52A1\u7AEF\u7684\u5171\u4EAB\u5BC6\u94A5\uFF1A\u542F\u52A8\u65F6\u6253\u5370\uFF0C\u6216\u901A\u8FC7 --token-file / --token-stdin \u6307\u5B9A\u3002\u7528\u4E8E\u53CC\u5411\u8BA4\u8BC1\u548C\u52A0\u5BC6\uFF0C\u4E0D\u4F1A\u660E\u6587\u4F20\u8F93","field.url":"\u5730\u5740\uFF08URL\uFF09","field.url.hint":"tcp://\u4E3B\u673A:\u7AEF\u53E3\u3001ws://\u4E3B\u673A:\u7AEF\u53E3/\u8DEF\u5F84\uFF0C\u6216\u7ECF TLS \u53CD\u5411\u4EE3\u7406\u7684 wss://\u2026","field.username":"\u7528\u6237\u540D","field.password":"\u5BC6\u7801","field.password.hint":"\u7559\u7A7A\u5219\u4F7F\u7528\u5BC6\u94A5\u6216 ssh-agent","field.privateKey":"\u79C1\u94A5\u8DEF\u5F84","field.privateKey.ph":"~/.ssh/id_ed25519","field.passphrase":"\u79C1\u94A5\u53E3\u4EE4","field.serverPath":"\u8FDC\u7AEF dsh-env-server \u8DEF\u5F84","field.serverPath.hint":"\u53EF\u9009\u3002\u586B\u5199\u540E\u901A\u8FC7 SSH \u542F\u52A8\u5B83\uFF0C\u83B7\u5F97 UDP \u96A7\u9053\u3001\u539F\u751F\u641C\u7D22\u7B49\u5B8C\u6574\u80FD\u529B","field.cwd":"\u9ED8\u8BA4\u76EE\u5F55","field.serial":"\u8BBE\u5907\u5E8F\u5217\u53F7","field.serial.hint":"\u6765\u81EA adb devices\uFF0C\u4F8B\u5982 emulator-5554 \u6216 192.168.1.20:5555","field.account":"\u8D26\u6237\u540D","field.account.hint":"1\u201320 \u4E2A\u5B57\u6BCD\u3001\u6570\u5B57\u3001_ \u6216 -","field.account.hint.create":"1\u201320 \u4E2A\u5B57\u6BCD\u3001\u6570\u5B57\u3001_ \u6216 -\u3002\u4F1A\u521B\u5EFA\u4E00\u4E2A\u53D7\u9650\u7684\u672C\u5730\u6807\u51C6\u8D26\u6237\uFF0CWindows \u4F1A\u5F39\u51FA\u7BA1\u7406\u5458\u786E\u8BA4\u3002","field.desktop":"\u684C\u9762","field.headlessParallel":"\u65E0\u754C\u9762\u4F7F\u7528\u53EF\u5E76\u884C","field.headlessParallel.hint":"\u591A\u4E2A\u4F1A\u8BDD\u53EF\u4EE5\u540C\u65F6\u4EE5\u65E0\u754C\u9762\u65B9\u5F0F\u4F7F\u7528\u5B83\uFF08\u6587\u4EF6\u3001\u547D\u4EE4\u3001\u8FDB\u7A0B\u3001\u96A7\u9053\uFF09\uFF1BGUI\uFF08\u622A\u56FE\u3001\u952E\u9F20\u3001\u754C\u9762\u64CD\u4F5C\uFF09\u59CB\u7EC8\u53EA\u80FD\u7531\u4E00\u4E2A\u4F1A\u8BDD\u6301\u6709\uFF0C\u5176\u4ED6\u4F1A\u8BDD\u6392\u961F\u3002\u5173\u95ED\u540E\u6574\u4E2A\u73AF\u5883\u540C\u4E00\u65F6\u95F4\u53EA\u5141\u8BB8\u4E00\u4E2A\u4F1A\u8BDD\u4F7F\u7528\u3002","field.mountMode":"\u6302\u8F7D\u65B9\u5F0F","field.mountMode.hint":"\u6302\u8F7D\u5230\u6B64\u73AF\u5883\u7684\u4F1A\u8BDD\u9ED8\u8BA4\u4EE5\u54EA\u79CD\u65B9\u5F0F\u5360\u7528\u5B83\u3002GUI \u88AB\u522B\u7684\u4F1A\u8BDD\u5360\u7528\u65F6\uFF0C\u6302\u8F7D\u9000\u56DE\u65E0\u754C\u9762\u65B9\u5F0F\u3002","field.mountMode.default":"\u9ED8\u8BA4\uFF08{mode}\uFF09","mode.headless":"\u65E0\u754C\u9762","mode.gui":"GUI","mode.headless.desc":"\u6587\u4EF6\u3001\u547D\u4EE4\u3001\u8FDB\u7A0B","mode.gui.desc":"\u53E6\u542B\u622A\u56FE\u3001\u952E\u9F20\u3001\u754C\u9762\u64CD\u4F5C","field.borrowable":"\u5141\u8BB8\u501F\u7528","field.kind":"\u7C7B\u578B","dialog.add":"\u6DFB\u52A0\u73AF\u5883","dialog.edit":"\u7F16\u8F91\u73AF\u5883","dialog.delete.title":"\u5220\u9664\u73AF\u5883","dialog.delete.body":"\u786E\u5B9A\u5220\u9664\u201C{name}\u201D\u5417\uFF1F\u6B63\u5728\u4F7F\u7528\u5B83\u7684\u4F1A\u8BDD\u4F1A\u7ACB\u5373\u65AD\u5F00\u3002","dialog.account.delete":"\u786E\u5B9A\u5220\u9664\u8D26\u6237\u201C{name}\u201D\u53CA\u5176\u7528\u6237\u914D\u7F6E\u6587\u4EF6\u5417\uFF1FWindows \u4F1A\u5F39\u51FA\u7BA1\u7406\u5458\u786E\u8BA4\u3002","server.help.title":"\u5982\u4F55\u5728\u76EE\u6807\u673A\u5668\u4E0A\u542F\u52A8\u670D\u52A1","server.help.body":"\u628A dsh-env-server \u590D\u5236\u5230\u76EE\u6807\u673A\u5668\uFF0C\u628A\u4EE4\u724C\u5199\u5165 token.txt\uFF08\u4E0D\u5199\u5219\u542F\u52A8\u65F6\u968F\u673A\u751F\u6210\u5E76\u6253\u5370\uFF09\uFF0C\u7136\u540E\u8FD0\u884C\u5176\u4E2D\u4E00\u6761\uFF1A","server.help.tcp":"TCP","server.help.ws":"WebSocket\uFF08\u53EF\u653E\u5728 TLS \u53CD\u5411\u4EE3\u7406\u4E4B\u540E\uFF09","field.direction":"\u8FDE\u63A5\u65B9\u5F0F","direction.direct":"\u76F4\u8FDE","direction.direct.desc":"dsh \u8FDE\u63A5\u5230\u76EE\u6807\u673A\u5668\u4E0A\u76D1\u542C\u7684\u670D\u52A1\uFF0C\u76EE\u6807\u673A\u5668\u9700\u8981\u80FD\u4ECE\u672C\u673A\u8BBF\u95EE\u5230\u3002","direction.reverse":"\u53CD\u5411\u8FDE\u63A5","direction.reverse.desc":"\u76EE\u6807\u673A\u5668\u4E3B\u52A8\u8FDE\u56DE\u672C\u673A\uFF0C\u9002\u5408\u6CA1\u6709\u516C\u7F51\u5730\u5740\u3001\u5728 NAT \u6216\u9632\u706B\u5899\u4E4B\u540E\u7684\u673A\u5668\u3002","direction.this":"\u672C\u673A","direction.target":"\u76EE\u6807\u673A","direction.locked":"\u521B\u5EFA\u540E\u4E0D\u80FD\u66F4\u6539\u8FDE\u63A5\u65B9\u5F0F","field.address":"\u5730\u5740","address.hostPort":"\u4E3B\u673A\u548C\u7AEF\u53E3","address.url":"URL","more.title":"\u66F4\u591A\u9009\u9879","reverse.listener.title":"\u672C\u673A\u76D1\u542C","reverse.listener.body":"\u6240\u6709\u53CD\u5411\u8FDE\u63A5\u5171\u7528\u8FD9\u4E9B\u76D1\u542C\u3002\u76EE\u6807\u673A\u5668\u8FD0\u884C dsh-env-server connect \u8FDE\u5230\u8FD9\u91CC\uFF1B\u9700\u8981\u7ECF\u516C\u7F51\u8BBF\u95EE\u65F6\uFF0C\u8BF7\u5728\u9632\u706B\u5899/\u8DEF\u7531\u5668\u653E\u884C\u7AEF\u53E3\uFF0C\u6216\u653E\u5728 TLS \u53CD\u5411\u4EE3\u7406\u4E4B\u540E\u3002","reverse.listener.off":"\u672A\u5F00\u542F","reverse.listener.on":"\u6B63\u5728\u76D1\u542C\u7AEF\u53E3 {port}","reverse.listener.none":"\u672A\u5F00\u542F\u4EFB\u4F55\u76D1\u542C","reverse.listener.autoTcp":"\u672A\u5F00\u542F\u4EFB\u4F55\u76D1\u542C \xB7 \u4FDD\u5B58\u65F6\u4F1A\u81EA\u52A8\u5F00\u542F TCP\uFF08\u7AEF\u53E3 {port}\uFF09","reverse.listener.failed":"{proto} \u76D1\u542C\u5931\u8D25\uFF1A{error}","reverse.listener.dirty":"\u6709\u672A\u5E94\u7528\u7684\u66F4\u6539\uFF0C\u4FDD\u5B58\u65F6\u4F1A\u4E00\u5E76\u5E94\u7528\u3002","reverse.next.title":"\u4FDD\u5B58\u4E4B\u540E","reverse.next.body":"\u4F1A\u751F\u6210\u4E00\u4E2A\u5BC6\u94A5\u548C\u4E00\u6761\u547D\u4EE4\u3002\u5728\u76EE\u6807\u673A\u5668\u4E0A\u8FD0\u884C\u8FD9\u6761\u547D\u4EE4\uFF0C\u5B83\u5C31\u4F1A\u8FDE\u4E0A\u6765\uFF0C\u65AD\u7EBF\u540E\u4E5F\u4F1A\u81EA\u52A8\u91CD\u8FDE\u3002","reverse.command.again":"\u5BC6\u94A5\u53EA\u5728\u751F\u6210\u65F6\u663E\u793A\u4E00\u6B21\u3002\u8981\u8BA9\u53E6\u4E00\u53F0\u673A\u5668\u8FDE\u63A5\u6216\u627E\u56DE\u547D\u4EE4\uFF0C\u53EF\u4EE5\u91CD\u65B0\u751F\u6210\uFF1B\u65E7\u5BC6\u94A5\u4F1A\u7ACB\u5373\u5931\u6548\u3002","reverse.bind":"\u76D1\u542C\u5730\u5740","reverse.path":"\u8DEF\u5F84","reverse.publicHost":"\u5BF9\u5916\u5730\u5740","reverse.publicHost.hint":"\u751F\u6210\u547D\u4EE4\u65F6\u76EE\u6807\u673A\u5668\u8981\u8FDE\u63A5\u7684\u4E3B\u673A\u540D\u6216 IP\uFF0C\u7559\u7A7A\u5219\u4F7F\u7528 {host}","reverse.rotate":"\u91CD\u65B0\u751F\u6210\u5BC6\u94A5\u548C\u547D\u4EE4","reverse.connected":"\u5DF2\u8FDE\u63A5 \xB7 {peer} \xB7 {active} \u4E2A\u4F1A\u8BDD","reverse.waiting":"\u7B49\u5F85\u76EE\u6807\u673A\u5668\u8FDE\u63A5\u2026","reverse.command.title":"\u5728\u76EE\u6807\u673A\u5668\u4E0A\u8FD0\u884C","reverse.command.body":"\u5BC6\u94A5\u53EA\u663E\u793A\u8FD9\u4E00\u6B21\u3002\u547D\u4EE4\u4F1A\u628A\u5B83\u5199\u5165\u4EC5\u81EA\u5DF1\u53EF\u8BFB\u7684\u6587\u4EF6\uFF0C\u7136\u540E\u8FDE\u63A5\u5E76\u5728\u65AD\u7EBF\u540E\u81EA\u52A8\u91CD\u8FDE\u3002","reverse.command.noListener":"\u6CA1\u6709\u5F00\u542F\u4EFB\u4F55\u76D1\u542C\uFF0C\u65E0\u6CD5\u751F\u6210\u547D\u4EE4\uFF1A\u5728\u201C\u672C\u673A\u76D1\u542C\u201D\u4E2D\u5F00\u542F TCP \u6216 WebSocket\uFF0C\u7136\u540E\u91CD\u65B0\u751F\u6210\u5BC6\u94A5\u3002","reverse.command.posix":"Linux / macOS","reverse.command.windows":"Windows (PowerShell)","reverse.secret":"\u5BC6\u94A5","browser.title":"\u9009\u62E9\u76EE\u5F55","browser.title.workspace":"\u65B0\u5EFA\u8FDC\u7A0B\u5DE5\u4F5C\u533A","browser.env":"\u73AF\u5883","browser.path":"\u8DEF\u5F84","browser.empty":"\u7A7A\u76EE\u5F55","browser.loading":"\u6B63\u5728\u8BFB\u53D6\u2026","browser.workspaceName":"\u5DE5\u4F5C\u533A\u540D\u79F0","browser.folderName":"\u6587\u4EF6\u5939\u540D\u79F0","browser.create":"\u521B\u5EFA\u5DE5\u4F5C\u533A","browser.createAndOpen":"\u521B\u5EFA\u5E76\u5F00\u59CB\u4F1A\u8BDD","browser.items":"{count} \u9879","ws.root":"{env} \xB7 {root}","lease.since":"{time}","lease.tunnels":"{count} \u6761\u96A7\u9053","lease.session":"\u4F1A\u8BDD {id}","lease.guiUsers":"GUI\uFF1A{ids}","chip.label":"\u73AF\u5883","chip.host":"\u672C\u673A","chip.host.title":"\u5728\u672C\u673A\uFF08\u8FD0\u884C dsh \u7684\u7535\u8111\uFF09\u4E0A\u8FD0\u884C","chip.mounted":"\u5728 {name} \u4E0A\u8FD0\u884C","chip.borrowed":"\u5DF2\u501F\u7528 {count} \u4E2A","pop.mount":"\u8FD0\u884C\u73AF\u5883","pop.mount.hint":"\u8FD9\u4E2A\u4F1A\u8BDD\u7684\u6587\u4EF6\u4E0E\u547D\u4EE4\u5DE5\u5177\u5728\u54EA\u91CC\u6267\u884C\u3002\u9009\u62E9\u5176\u4ED6\u73AF\u5883\u65F6\u8FD8\u9700\u8981\u9009\u4E00\u4E2A\u76EE\u5F55\u3002","pop.host":"\u672C\u673A","pop.host.desc":"\u8FD0\u884C dsh \u7684\u7535\u8111\uFF0C\u76F4\u63A5\u4F7F\u7528\u5F53\u524D\u5DE5\u4F5C\u533A","pop.mount.active":"{name}","pop.mount.locked":"\u4F1A\u8BDD\u5DF2\u5F00\u59CB\uFF0C\u8FD0\u884C\u73AF\u5883\u4E0D\u53EF\u66F4\u6539\u3002","pop.mount.fromWorkspace":"\u6765\u81EA\u8FDC\u7A0B\u5DE5\u4F5C\u533A","pop.mount.inherited":"\u4E0E\u7236\u4F1A\u8BDD\u5171\u4EAB","pop.mount.pick":"\u9009\u62E9\u76EE\u5F55\u2026","pop.mount.error":"\u6302\u8F7D\u5931\u8D25\uFF1A{message}","pop.mount.pending":"\u5C06\u5728\u4F1A\u8BDD\u5F00\u59CB\u65F6\u6302\u8F7D","pop.borrow":"\u53EF\u501F\u7528","pop.borrow.hint":"\u667A\u80FD\u4F53\u53EF\u4EE5\u7528 env_borrow \u4E34\u65F6\u501F\u7528\u8FD9\u4E9B\u73AF\u5883\u3002","pop.borrow.inherit.all":"\u9ED8\u8BA4\uFF1A\u5168\u90E8\u73AF\u5883","pop.borrow.inherit.workspace":"\u7EE7\u627F\u81EA\u5DE5\u4F5C\u533A","pop.borrow.custom":"\u672C\u4F1A\u8BDD\u81EA\u5B9A\u4E49","pop.borrow.reset":"\u6062\u590D\u9ED8\u8BA4","pop.borrow.saveWorkspace":"\u8BBE\u4E3A\u6B64\u5DE5\u4F5C\u533A\u9ED8\u8BA4","pop.borrow.saved":"\u5DF2\u4FDD\u5B58\u4E3A\u5DE5\u4F5C\u533A\u9ED8\u8BA4","pop.held":"\u5DF2\u501F\u7528","pop.held.none":"\u5C1A\u672A\u501F\u7528\u4EFB\u4F55\u73AF\u5883","pop.tools":"{count} \u4E2A\u5DE5\u5177","err.generic":"\u64CD\u4F5C\u5931\u8D25\uFF1A{message}","time.justNow":"\u521A\u521A","time.minutes":"{n} \u5206\u949F\u524D","time.hours":"{n} \u5C0F\u65F6\u524D","info.os":"{os} \xB7 {arch}","empty.title":"\u6DFB\u52A0\u7B2C\u4E00\u4E2A\u73AF\u5883","empty.body":"\u8FDE\u63A5\u670D\u52A1\u5668\u3001\u624B\u673A\u6216\u6D4B\u8BD5\u8D26\u6237\uFF0C\u8BA9\u667A\u80FD\u4F53\u5728\u771F\u5B9E\u8BBE\u5907\u4E0A\u5DE5\u4F5C\u3002","adb.error":"adb \u4E0D\u53EF\u7528\uFF1A{message}"},xs={panel:"Environments","page.title":"Environments","page.subtitle":"Let agents use other devices: mount one as the workspace, or borrow it when needed.","action.refresh":"Refresh","action.add":"Add environment","action.test":"Test connection","action.testing":"Connecting\u2026","action.edit":"Edit","action.delete":"Delete","action.cancel":"Cancel","action.save":"Save","action.saveAndTest":"Save and test","action.close":"Close","action.viewDesktop":"View desktop","session.title":"Separate-session mode","session.purpose":"Each Windows account logs on to a session of its own: its own mouse pointer and real input, never fighting you for the mouse or showing up on your screen.","session.probing":"Checking this computer\u2026","session.badge.probing":"Checking","session.badge.ready":"Ready","session.badge.setup":"Needs setup","session.badge.reboot":"Reboot pending","session.badge.error":"Check failed","session.line.ready":"Accounts set to \u201CSeparate session\u201D log on to a Windows session of their own.","session.line.install.home":"Windows Home cannot host Remote Desktop sessions; installing the TermWrap patch makes it possible.","session.line.install.client":"This Windows edition allows one session at a time; installing the TermWrap patch lifts that limit.","session.line.enable":"Server editions host several sessions natively; only the Remote Desktop host needs switching on.","session.line.reboot":"TermWrap is installed, but the service did not pick it up; it takes effect after a reboot.","session.line.manual":"This build does not bundle TermWrap; install it manually following docs/session-mode.md and reboot.","session.line.unsupported":"Separate sessions are only available on Windows hosts.","session.line.error":"Could not check: {message}","session.check.termwrap":"TermWrap multi-session patch","session.check.rdp":"Remote Desktop host enabled","session.check.rfxvmt":"rfxvmt.dll component","session.check.group":"Remote Desktop Users group","session.check.service":"Terminal Services running","session.check.listener":"Port 3389 listening","session.action.install":"Install TermWrap","session.action.enable":"Enable Remote Desktop","session.action.recheck":"Check again","session.action.details":"Details","session.action.hide":"Hide","session.working":"Working\u2026","session.note.admin":"Needs administrator approval; usually no reboot.","session.note.adminReboot":"Needs administrator approval; Terminal Services is restarted afterwards, so no reboot is needed.","session.install.detail":"Bundled TermWrap {version} (MIT, {files} files, nothing is downloaded). The install adds %ProgramFiles%\\RDP Wrapper to the Defender exclusions, points the Terminal Services service DLL at it, enables Remote Desktop and then restarts that service so the patch is active at once (only a failed restart needs a reboot).","session.enable.detail":"Switches the Remote Desktop host on (fDenyTSConnections=0) and starts Terminal Services.","session.ready.detail":"This computer can host a separate Windows session per account.","session.edition":"Edition: {edition}.","session.done.enable":"Enabled. If the status does not change, choose \u201CCheck again\u201D.","session.done.install":"Installed and already active; no reboot is needed.","session.done.installReboot":"Installed, but Terminal Services did not pick the patch up; restart the computer.","action.pause":"Pause","action.resume":"Resume","desktop.title":"{{name}}'s desktop","desktop.mode.shared":"Shared desktop","desktop.mode.private":"Private desktop","desktop.mode.session":"Separate session","desktop.mode.shared.desc":"Runs on your screen and shares your mouse and keyboard","desktop.mode.private.desc":"Runs on a hidden desktop; watch it with \u201CView desktop\u201D","desktop.mode.session.desc":"Logs on to its own Windows session with its own pointer and real input","desktop.mode.session.notReady":"You can also save now; it connects once setup is done.","desktop.card.notReady":"This computer cannot host separate sessions yet, so it cannot connect.","desktop.card.setup":"Set up","desktop.saved.notReady":"Saved. The account connects once separate sessions are set up on this computer.","desktop.size":"{{w}}\xD7{{h}}","desktop.fps":"{{fps}} fps","desktop.connecting":"Fetching the screen\u2026","desktop.hint":"Live view of this environment\u2019s desktop (about 4 frames per second, downscaled). Windows on a private desktop never appear on your own desktop.","action.newWorkspace":"New remote workspace","action.browse":"Browse files","action.release":"Release","action.return":"Return","action.newSession":"New session","action.remove":"Remove","action.addDevice":"Add to list","action.create":"Create","action.manage":"Manage environments\u2026","action.apply":"Apply","action.unmount":"Unmount","action.choose":"Choose this folder","action.up":"Up","action.home":"Home","action.newFolder":"New folder","action.open":"Open","action.retry":"Retry","action.done":"Done","action.copy":"Copy","action.copied":"Copied","action.saveAndGenerate":"Save and get command","kind.local":"Local process","kind.server":"Environment server","kind.ssh":"SSH","kind.adb":"Android (ADB)","kind.winuser":"Windows account","kind.reverse":"Environment server (reverse)","kind.local.desc":"A separate dsh-env-server process on the computer running dsh","kind.server.desc":"A machine running dsh-env-server, reached directly or dialing in","kind.ssh.desc":"A server reached over SSH","kind.adb.desc":"A phone or emulator controlled through adb","kind.winuser.desc":"A restricted test account on this computer that can run GUI programs","kind.reverse.desc":"The target machine dials in (when it has no public address)","section.environments":"Environments","section.workspaces":"Remote workspaces","section.workspaces.hint":"Sessions in a remote workspace read, write and run commands inside that environment.","section.workspaces.empty":"No remote workspaces yet. Choose \u201CNew remote workspace\u201D on any environment card.","section.leases":"In use","section.leases.empty":"No session is using an environment right now.","section.accounts":"Windows test accounts","section.accounts.hint":"Restricted local standard accounts. Programs started as one appear on the current desktop so agents can test user interfaces. Creating and deleting needs administrator approval.","section.accounts.empty":"No test accounts yet.","status.available":"Available","status.busy":"In use","status.busyBy":"In use by {who}","status.queue":"{count} waiting","status.offline":"Offline","status.unknown":"Not checked","status.connected":"Reachable \xB7 {ms} ms","status.failed":"Connection failed","status.discovered":"Discovered","status.builtin":"Built in","status.shared":"Headless shared","status.exclusive":"Exclusive","status.guiBy":"GUI: {who}","badge.mount":"Mounted","badge.borrow":"Borrowed","field.name":"Name","field.name.ph":"e.g. Test phone Pixel 8","field.id":"Identifier","field.id.hint":'How an agent names this environment after borrowing it, as environment: "{alias}" in its env_* tool calls',"field.description":"Notes","field.host":"Host","field.port":"Port","field.token":"Token","field.token.hint":"The server\u2019s shared secret: printed at start, or set with --token-file / --token-stdin. It authenticates both sides and keys the encryption; it is never sent in clear","field.url":"Address (URL)","field.url.hint":"tcp://host:port, ws://host:port/path, or wss://\u2026 through a TLS reverse proxy","field.username":"User name","field.password":"Password","field.password.hint":"Leave empty to use a key or ssh-agent","field.privateKey":"Private key path","field.privateKey.ph":"~/.ssh/id_ed25519","field.passphrase":"Key passphrase","field.serverPath":"Remote dsh-env-server path","field.serverPath.hint":"Optional. When set it is started over SSH for full capabilities such as UDP tunnels and native search","field.cwd":"Default directory","field.serial":"Device serial","field.serial.hint":"From adb devices, e.g. emulator-5554 or 192.168.1.20:5555","field.account":"Account name","field.account.hint":"1\u201320 letters, digits, _ or -","field.account.hint.create":"1\u201320 letters, digits, _ or -. A restricted local standard account is created; Windows asks for administrator approval.","field.desktop":"Desktop","field.headlessParallel":"Parallel headless use","field.headlessParallel.hint":"Several sessions may use it headless at the same time (files, commands, processes, tunnels); the GUI (screenshots, input, UI automation) is always held by one session at a time while others wait. When off, only one session may use the environment at all.","field.mountMode":"Mount mode","field.mountMode.hint":"How sessions mounted on this environment occupy it by default. When another session holds the GUI, the mount falls back to headless.","field.mountMode.default":"Default ({mode})","mode.headless":"Headless","mode.gui":"GUI","mode.headless.desc":"Files, commands, processes","mode.gui.desc":"Also screenshots, input, UI automation","field.borrowable":"Allow borrowing","field.kind":"Type","dialog.add":"Add environment","dialog.edit":"Edit environment","dialog.delete.title":"Delete environment","dialog.delete.body":"Delete \u201C{name}\u201D? Sessions using it are disconnected immediately.","dialog.account.delete":"Delete the account \u201C{name}\u201D and its user profile? Windows asks for administrator approval.","server.help.title":"How to start the server on the target machine","server.help.body":"Copy dsh-env-server to the target machine, put the token in token.txt (or omit it to have one generated and printed), then run one of:","server.help.tcp":"TCP","server.help.ws":"WebSocket (can sit behind a TLS reverse proxy)","field.direction":"Connection","direction.direct":"Direct","direction.direct.desc":"dsh connects to the server listening on the target; the target must be reachable from here.","direction.reverse":"Reverse","direction.reverse.desc":"The target dials in to this computer \u2014 for machines without a public address or behind NAT or a firewall.","direction.this":"This PC","direction.target":"Target","direction.locked":"The connection type cannot be changed after creation","field.address":"Address","address.hostPort":"Host and port","address.url":"URL","more.title":"More options","reverse.listener.title":"Listeners on this computer","reverse.listener.body":"Shared by all reverse connections. The target runs dsh-env-server connect and dials in here; for access over the internet open the port in your firewall/router or put it behind a TLS reverse proxy.","reverse.listener.off":"Off","reverse.listener.on":"Listening on port {port}","reverse.listener.none":"No listener enabled","reverse.listener.autoTcp":"No listener enabled \xB7 TCP (port {port}) is switched on when you save","reverse.listener.failed":"{proto} listener failed: {error}","reverse.listener.dirty":"Unapplied changes are applied when you save.","reverse.next.title":"After saving","reverse.next.body":"You get a secret and a command. Run the command on the target machine and it connects, reconnecting automatically after drops.","reverse.command.again":"The secret is shown only when it is generated. To connect another machine or get the command again, generate a new one; the old secret stops working at once.","reverse.bind":"Bind address","reverse.path":"Path","reverse.publicHost":"Public address","reverse.publicHost.hint":"Host name or IP the target machine dials, used in the generated command; empty = {host}","reverse.rotate":"New secret and command","reverse.connected":"Connected \xB7 {peer} \xB7 {active} sessions","reverse.waiting":"Waiting for the target machine to connect\u2026","reverse.command.title":"Run on the target machine","reverse.command.body":"The secret is shown only this once. The command stores it in a file only you can read, connects, and reconnects automatically.","reverse.command.noListener":"No listener is enabled, so there is no command: enable TCP or WebSocket under Listeners, then generate a new secret.","reverse.command.posix":"Linux / macOS","reverse.command.windows":"Windows (PowerShell)","reverse.secret":"Secret","browser.title":"Choose a folder","browser.title.workspace":"New remote workspace","browser.env":"Environment","browser.path":"Path","browser.empty":"Empty folder","browser.loading":"Reading\u2026","browser.workspaceName":"Workspace name","browser.folderName":"Folder name","browser.create":"Create workspace","browser.createAndOpen":"Create and start session","browser.items":"{count} items","ws.root":"{env} \xB7 {root}","lease.since":"{time}","lease.tunnels":"{count} tunnels","lease.session":"Session {id}","lease.guiUsers":"GUI: {ids}","chip.label":"Environment","chip.host":"This computer","chip.host.title":"Runs on this computer (the one running dsh)","chip.mounted":"Runs on {name}","chip.borrowed":"{count} borrowed","pop.mount":"Runs on","pop.mount.hint":"Where this session\u2019s file and shell tools run. Another environment also needs a folder.","pop.host":"This computer","pop.host.desc":"The computer running dsh, using the current workspace directly","pop.mount.active":"{name}","pop.mount.locked":"The session has started; where it runs can no longer change.","pop.mount.fromWorkspace":"From the remote workspace","pop.mount.inherited":"Shared with the parent session","pop.mount.pick":"Choose a folder\u2026","pop.mount.error":"Mount failed: {message}","pop.mount.pending":"Mounts when the session starts","pop.borrow":"Borrowable","pop.borrow.hint":"The agent may borrow these environments with env_borrow.","pop.borrow.inherit.all":"Default: every environment","pop.borrow.inherit.workspace":"Inherited from the workspace","pop.borrow.custom":"Customized for this session","pop.borrow.reset":"Reset to default","pop.borrow.saveWorkspace":"Make default for this workspace","pop.borrow.saved":"Saved as the workspace default","pop.held":"Borrowed","pop.held.none":"Nothing borrowed yet","pop.tools":"{count} tools","err.generic":"Something went wrong: {message}","time.justNow":"just now","time.minutes":"{n} min ago","time.hours":"{n} h ago","info.os":"{os} \xB7 {arch}","empty.title":"Add your first environment","empty.body":"Connect a server, a phone or a test account so agents can work on real devices.","adb.error":"adb is unavailable: {message}"},bs={"ws.state.available":"\u53EF\u7528","ws.state.busy":"\u4F7F\u7528\u4E2D","ws.state.offline":"\u4E0D\u53EF\u7528","ws.state.error":"\u51FA\u9519","ws.state.unknown":"\u672A\u68C0\u6D4B","ws.tag.remote":"\u8FDC\u7A0B\u5DE5\u4F5C\u533A \xB7 {name} \xB7 {root}","pop.mount.blocked":"\u6302\u8F7D\u6210\u529F\u4E4B\u524D\uFF0C\u8FD9\u4E2A\u4F1A\u8BDD\u4E0D\u80FD\u7EE7\u7EED\u5BF9\u8BDD\u3002","action.remount":"\u91CD\u65B0\u6302\u8F7D","pop.borrow.clearWorkspace":"\u6E05\u9664\u5DE5\u4F5C\u533A\u9ED8\u8BA4","env.builtinLocal":"\u672C\u673A\uFF08\u72EC\u7ACB\u8FDB\u7A0B\uFF09"},gs={"ws.state.available":"Available","ws.state.busy":"In use","ws.state.offline":"Unavailable","ws.state.error":"Error","ws.state.unknown":"Not checked","ws.tag.remote":"Remote workspace \xB7 {name} \xB7 {root}","pop.mount.blocked":"This session cannot continue until its environment is mounted.","action.remount":"Mount again","pop.borrow.clearWorkspace":"Clear workspace default","env.builtinLocal":"This computer (separate process)"},Dn={zh:{...hs,...bs},en:{...xs,...gs}};var l=ie(require("react"),1),on=require("react"),ce=require("@deepseek-ai/dsh-client-ui-primitives");var Y=ie(require("react"),1),de=require("react"),Re=require("@deepseek-ai/dsh-client-ui-primitives");var ws=250;function Vn({env:e,t:n,onClose:t}){let[r,i]=(0,de.useState)(void 0),[p,o]=(0,de.useState)(void 0),[d,a]=(0,de.useState)(!1),[u,y]=(0,de.useState)(0),m=(0,de.useRef)([]);(0,de.useEffect)(()=>{if(d)return;let c=!1,f,C=new AbortController,R=async()=>{try{let k=await E("desktop.frame",{envId:e.id,maxWidth:1100},C.signal);if(c)return;i(k),o(void 0);let w=Date.now();m.current=[...m.current.filter(h=>w-h<2e3),w],y(Math.round(m.current.length/2*10)/10)}catch(k){if(c||C.signal.aborted)return;o(H(k))}c||(f=setTimeout(()=>{R()},ws))};return R(),()=>{c=!0,C.abort(),clearTimeout(f)}},[e.id,d]);let I=r?.desktop??(e.config.desktop==="private"?n("desktop.mode.private"):void 0);return Y.createElement(Re.Modal,{open:!0,onClose:t,title:n("desktop.title",{name:e.name}),closeLabel:n("action.close"),className:"envx-dialog envx-desktop",footer:Y.createElement("div",{className:"envx-footer"},Y.createElement("span",{className:"envx-chip","data-tone":I?"accent":void 0},I??n("desktop.mode.shared")),r&&Y.createElement("span",{className:"envx-chip"},n("desktop.size",{w:r.width,h:r.height})),!d&&u>0&&Y.createElement("span",{className:"envx-chip"},n("desktop.fps",{fps:String(u)})),Y.createElement("span",{className:"envx-spacer"}),Y.createElement(Re.Button,{variant:"ghost",onClick:()=>a(c=>!c)},n(d?"action.resume":"action.pause")),Y.createElement(Re.Button,{variant:"primary",onClick:t},n("action.close")))},Y.createElement("div",{className:"envx-desktop-frame"},r?Y.createElement("img",{alt:n("desktop.title",{name:e.name}),src:`data:${r.mime};base64,${r.data}`,style:{width:"100%",display:"block",borderRadius:6}}):Y.createElement("div",{className:"envx-empty"},p??n("desktop.connecting"))),r&&p&&Y.createElement("div",{className:"envx-result","data-ok":"false"},p),r&&!p&&Y.createElement("div",{className:"envx-help",style:{marginTop:8}},n("desktop.hint")))}var s=ie(require("react"),1),M=require("react"),F=require("@deepseek-ai/dsh-client-ui-primitives");var P=ie(require("react"),1),le=require("react");var ys=[["termwrap","termwrap-missing"],["rdp","rdp-disabled"],["rfxvmt","rfxvmt-missing"],["group","rd-users-group-missing"],["service","term-service-stopped"],["listener","listener-down"]];function Wn(e){return e.needsTermWrap??e.editionKind!=="server"}function An(e,n=!1){return e.ready?"ready":e.missing.includes("not-windows")?"unsupported":Wn(e)?n||e.termsrv?.wrapperInstalled||!e.missing.includes("termwrap-missing")?"reboot":e.termwrap.present?"install":"manual":"enable"}function Ln(e){let n=Wn(e);return ys.filter(([t])=>n||t!=="termwrap").map(([t,r])=>{let i=e.missing.indexOf(r);return{id:t,ok:i<0,reason:i<0?void 0:e.reasons[i]}})}var me={status:void 0,error:void 0,loading:!1,installed:!1},en=new Set,Ue=e=>{me={...me,...e};for(let n of en)n()},ks=e=>(en.add(e),()=>{en.delete(e)});async function nn(){if(!me.loading){Ue({loading:!0,error:void 0});try{let e=await E("session.status");Ue({status:e,loading:!1,installed:e.ready?!1:me.installed})}catch(e){Ue({error:H(e),loading:!1})}}}function Ee(e){let n=(0,le.useSyncExternalStore)(ks,()=>me),t=e==="win32";(0,le.useEffect)(()=>{t&&!me.status&&!me.loading&&!me.error&&nn()},[t]);let r=n.status?An(n.status,n.installed):void 0;return{...n,phase:r,ready:r==="ready",reload:nn}}function Ss(e,n){if(n.error)return e("session.line.error",{message:n.error});if(!n.status)return e("session.probing");switch(n.phase){case"ready":return e("session.line.ready");case"install":return n.status.editionKind==="home"?e("session.line.install.home"):e("session.line.install.client");case"manual":return e("session.line.manual");case"reboot":return e("session.line.reboot");case"enable":return e("session.line.enable");default:return e("session.line.unsupported")}}function sn({t:e,state:n}){let t=n.error?"error":n.status?n.phase==="ready"?"ok":n.phase==="reboot"?"info":"warn":"idle",r=n.error?e("session.badge.error"):n.status?n.phase==="ready"?e("session.badge.ready"):n.phase==="reboot"?e("session.badge.reboot"):e("session.badge.setup"):e("session.badge.probing");return P.createElement("span",{className:"envx-sess-badge","data-tone":t},t==="idle"?P.createElement(L,{size:11}):P.createElement("i",null),r)}function Bn({t:e,platform:n,variant:t="panel",footnote:r}){let i=Ee(n),[p,o]=(0,le.useState)(!1),[d,a]=(0,le.useState)(!1),[u,y]=(0,le.useState)(void 0),[m,I]=(0,le.useState)(void 0);if(n!=="win32")return null;let{status:c,phase:f}=i,C=async h=>{a(!0),y(void 0),I(void 0);try{let z=await E(h);if(h==="session.install"){let $=z?.rebootRequired===!0;Ue({installed:$}),I(e($?"session.done.installReboot":"session.done.install"))}else I(e("session.done.enable"));await nn()}catch(z){y(H(z))}finally{a(!1)}},R=f==="install"?P.createElement("button",{type:"button",className:"envx-linkbtn","data-primary":"",disabled:d,onClick:()=>{C("session.install")}},d?P.createElement(L,{size:14}):null,e(d?"session.working":"session.action.install")):f==="enable"?P.createElement("button",{type:"button",className:"envx-linkbtn","data-primary":"",disabled:d,onClick:()=>{C("session.enable")}},d?P.createElement(L,{size:14}):null,e(d?"session.working":"session.action.enable")):f==="reboot"||i.error?P.createElement("button",{type:"button",className:"envx-linkbtn",disabled:i.loading,onClick:()=>{i.reload()}},i.loading?P.createElement(L,{size:14}):P.createElement(Ne,{size:14}),e("session.action.recheck")):null,k=f==="install"?e("session.note.adminReboot"):f==="enable"?e("session.note.admin"):void 0,w=c?Ln(c):[];return P.createElement("section",{className:"envx-sess","data-variant":t,"data-phase":f??"probing","data-open":p?"":void 0},P.createElement("div",{className:"envx-sess-head"},t==="panel"&&P.createElement("span",{className:"envx-tile","data-kind":"winuser"},P.createElement(Ke,{size:20})),P.createElement("div",{className:"envx-sess-main"},t==="panel"&&P.createElement("div",{className:"envx-sess-title"},P.createElement("strong",null,e("session.title")),P.createElement(sn,{t:e,state:i})),P.createElement("span",{className:"envx-sess-line"},Ss(e,i))),P.createElement("div",{className:"envx-sess-actions"},c&&P.createElement("button",{type:"button",className:"envx-sess-toggle","aria-expanded":p,onClick:()=>o(h=>!h)},e(p?"session.action.hide":"session.action.details"),P.createElement(Fe,{size:14})),R)),(k||r)&&!p&&P.createElement("div",{className:"envx-sess-note"},[k,r].filter(Boolean).join(" ")),u&&P.createElement("div",{className:"envx-error-line"},u),m&&!u&&P.createElement("div",{className:"envx-sess-note"},m),p&&c&&P.createElement("div",{className:"envx-sess-body"},t==="panel"&&P.createElement("p",{className:"envx-sess-purpose"},e("session.purpose")),P.createElement("ul",{className:"envx-sess-checks"},w.map(h=>P.createElement("li",{key:h.id,"data-ok":h.ok?"":void 0,title:h.reason},P.createElement("i",null,h.ok?P.createElement(re,{size:11}):null),P.createElement("span",null,e(`session.check.${h.id}`))))),P.createElement("div",{className:"envx-sess-foot"},P.createElement("span",null,f==="install"||f==="manual"||f==="reboot"?e("session.install.detail",{version:c.termwrap.version??"\u2014",files:String(c.termwrap.files.length)}):e(f==="enable"?"session.enable.detail":"session.ready.detail"),c.edition?` ${e("session.edition",{edition:c.edition})}`:""),f!=="reboot"&&!i.error&&P.createElement("button",{type:"button",className:"envx-textbtn","data-quiet":"",disabled:i.loading,onClick:()=>{i.reload()}},e("session.action.recheck")))))}var Ns=["server","ssh","adb","winuser"];function $n(e){let n=String(e).toLowerCase().replace(/[^a-z0-9]+/g,"_").replace(/^_+|_+$/g,"").slice(0,24)||"env";return/^[a-z]/.test(n)||(n=`env_${n}`),n}function B({label:e,hint:n,children:t}){return s.createElement("div",{className:"envx-field"},s.createElement("label",null,e),t,n&&s.createElement("small",null,n))}function A({value:e,onChange:n,mono:t,...r}){return s.createElement("input",{className:"envx-input","data-mono":t?"":void 0,value:e??"",onChange:i=>n(i.target.value),spellCheck:!1,autoComplete:"off",...r})}function tn({title:e,summary:n,open:t,onToggle:r,children:i}){return s.createElement("div",{className:"envx-disc","data-open":t?"":void 0},s.createElement("button",{type:"button",className:"envx-disc-head","aria-expanded":t,onClick:r},s.createElement(Fe,{size:14}),s.createElement("span",{className:"envx-disc-title"},e),n&&s.createElement("span",{className:"envx-disc-summary"},n)),t&&s.createElement("div",{className:"envx-disc-body"},i))}function _e({label:e,text:n,t}){let[r,i]=(0,M.useState)(!1),p=()=>{navigator.clipboard?.writeText(n).then(()=>{i(!0),setTimeout(()=>i(!1),1500)})};return s.createElement("div",{className:"envx-cmd"},e&&s.createElement("span",{className:"envx-cmd-label"},e),s.createElement("div",{className:"envx-cmd-body"},s.createElement("code",null,n),s.createElement("button",{type:"button",className:"envx-cmd-copy","data-copied":r?"":void 0,"aria-label":t("action.copy"),onClick:p},r?s.createElement(re,{size:14}):s.createElement(Rn,{size:14}),s.createElement("span",null,t(r?"action.copied":"action.copy")))))}var Hn={server:{port:7461},ssh:{},adb:{},winuser:{},reverse:{}};function Fn({open:e,environment:n,environments:t,platform:r,defaultMountMode:i,onClose:p,t:o}){let d=!!n,[a,u]=(0,M.useState)(n?.kind),[y,m]=(0,M.useState)(""),[I,c]=(0,M.useState)(""),[f,C]=(0,M.useState)(!1),[R,k]=(0,M.useState)(""),[w,h]=(0,M.useState)({}),[z,$]=(0,M.useState)("host"),[T,v]=(0,M.useState)(!0),[D,te]=(0,M.useState)(""),[ee,oe]=(0,M.useState)(!1),[W,be]=(0,M.useState)(!1),[X,ne]=(0,M.useState)(void 0),[ue,ge]=(0,M.useState)(void 0),[Me,Ce]=(0,M.useState)(void 0),Te=Ee(a==="winuser"?r:void 0),we=zs(e&&a==="reverse");(0,M.useEffect)(()=>{e&&(u(n?.kind),m(n?.name??""),c(n?.id??""),C(!!n),k(n?.description??""),h(n?.config??{}),$(n?.config.url?"url":"host"),v(n?.headlessParallel??!0),te(n?.mountMode??""),oe(!1),ne(void 0),ge(void 0),Ce(void 0),be(!1))},[e,n]);let De=g=>{u(g),h({...Hn[g]}),$("host"),v(!0),te(""),ne(void 0)},Ve=g=>{g!==a&&(h(K=>({...Hn[g],...K.cwd?{cwd:K.cwd}:{}})),u(g),ne(void 0))},ye={headlessParallel:T,mountMode:D||null},U=(g,K)=>h(ve=>({...ve,[g]:K})),fe=f?I:$n(y||a||"env"),S=Ns.filter(g=>g!=="winuser"||r==="win32"),q=t?.find(g=>g.id===(Me??n?.id))??n,_=()=>{let{url:g,host:K,port:ve,...rn}=w;return z==="url"?{...rn,url:g}:{...rn,host:K,port:ve}},ae=a&&y.trim()&&(a==="server"&&(z==="url"?!!w.url:!!(w.host&&w.port))||a==="reverse"||a==="ssh"&&w.host||a==="adb"&&w.serial||a==="winuser"&&w.account),We=async()=>{be(!0),ne(void 0);try{let g;if(a==="reverse"){await we.ensure();let ve=await E("save",{environment:{id:fe,name:y.trim(),kind:a,description:R,...ye,config:w}});O(),C(!0),c(ve.environment.id),Ce(ve.environment.id),ve.reverse?ge(ve.reverse):p();return}if(a==="winuser"&&!d?(g=(await E("winuser.create",{name:w.account,environmentName:y.trim(),desktop:w.desktop})).environment,(!T||D)&&(g=(await E("save",{environment:{...g,...ye,config:{account:w.account,desktop:w.desktop}}})).environment)):g=(await E("save",{environment:{id:fe,name:y.trim(),kind:a,description:R,...ye,config:a==="server"?_():w}})).environment,O(),a==="winuser"&&w.desktop==="session"&&!Te.ready){ne({ok:!0,text:o("desktop.saved.notReady")}),setTimeout(p,1400);return}let K=await E("test",{id:g.id});O(),K.ok?(ne({ok:!0,text:o("status.connected",{ms:K.ms??0})+(K.info?` \u2014 ${K.info.os}${K.info.arch?` \xB7 ${K.info.arch}`:""}${K.info.user?` \xB7 ${K.info.user}`:""}`:"")}),setTimeout(p,900)):(ne({ok:!1,text:K.error??""}),C(!0),c(g.id))}catch(g){ne({ok:!1,text:H(g)})}finally{be(!1)}},Jn=W?o(a==="reverse"?"session.working":"action.testing"):a==="reverse"?o(d?"action.save":"action.saveAndGenerate"):a==="winuser"&&w.desktop==="session"&&!Te.ready?o("action.save"):o("action.saveAndTest"),Yn=a?s.createElement("div",{className:"envx-footer"},!d&&!ue&&s.createElement(F.Button,{variant:"ghost",onClick:()=>{u(void 0),ne(void 0)}},"\u2039 ",o("field.kind")),s.createElement("span",{className:"envx-spacer"}),!ue&&s.createElement(F.Button,{variant:"ghost",onClick:p},o("action.cancel")),ue?s.createElement(F.Button,{variant:"primary",onClick:p},o("action.done")):s.createElement(F.Button,{variant:"primary",disabled:!ae||W,icon:W?s.createElement(L,{size:16}):void 0,onClick:()=>{We()}},Jn)):void 0,Xn=[o(T?"status.shared":"status.exclusive"),`${o("field.mountMode")} \xB7 ${D?o(`mode.${D}`):o("field.mountMode.default",{mode:o(`mode.${i??"headless"}`)})}`,R.trim()].filter(Boolean).join(" \xB7 "),Zn=a==="server"||a==="reverse";return s.createElement(F.Modal,{open:e,onClose:p,title:o(d?"dialog.edit":"dialog.add"),closeLabel:o("action.close"),footer:Yn,className:"envx-dialog"},!a&&s.createElement("div",{className:"envx-kinds"},S.map(g=>s.createElement("button",{type:"button",key:g,className:"envx-kind","data-kind":g,onClick:()=>De(g)},s.createElement("span",{className:"envx-tile","data-kind":g},s.createElement(Z,{kind:g})),s.createElement("span",null,s.createElement("strong",null,o(`kind.${g}`)),s.createElement("span",null,o(`kind.${g}.desc`)))))),a&&ue&&s.createElement("div",{className:"envx-form","data-kind":a},s.createElement(Es,{reveal:ue,env:q,t:o})),a&&!ue&&s.createElement("div",{className:"envx-form","data-kind":a},Zn&&s.createElement(Is,{value:a==="reverse"?"reverse":"server",onChange:Ve,locked:d,t:o}),s.createElement("div",{className:"envx-field-row","data-even":""},s.createElement(B,{label:o("field.name")},s.createElement(A,{value:y,onChange:m,placeholder:o("field.name.ph"),"data-modal-autofocus":""})),s.createElement(B,{label:o("field.id")},s.createElement(A,{value:fe,mono:!0,disabled:d,onChange:g=>{c(g.replace(/[^A-Za-z0-9_.-]/g,"")),C(!0)}}))),!d&&s.createElement("small",{className:"envx-form-note"},o("field.id.hint",{alias:$n(fe)})),a==="server"&&s.createElement(Cs,{config:w,set:U,addr:z,onAddr:$,editing:d,t:o}),a==="reverse"&&s.createElement(Ps,{environment:q,editing:d,listeners:we,onReveal:g=>{Ce(fe),ge(g)},t:o},s.createElement(B,{label:o("field.cwd")},s.createElement(A,{value:w.cwd,onChange:g=>U("cwd",g),placeholder:"/home/me/project",mono:!0}))),a==="ssh"&&s.createElement(s.Fragment,null,s.createElement("div",{className:"envx-field-row"},s.createElement(B,{label:o("field.host")},s.createElement(A,{value:w.host,onChange:g=>U("host",g),placeholder:"build.example.com",mono:!0})),s.createElement(B,{label:o("field.port")},s.createElement(A,{value:w.port,onChange:g=>U("port",g.replace(/\D/g,"")),inputMode:"numeric",placeholder:"22",mono:!0}))),s.createElement("div",{className:"envx-field-row","data-even":""},s.createElement(B,{label:o("field.username")},s.createElement(A,{value:w.username,onChange:g=>U("username",g),mono:!0})),s.createElement(B,{label:o("field.password")},s.createElement(A,{value:w.password,onChange:g=>U("password",g),type:"password"}))),s.createElement("small",{className:"envx-form-note"},o("field.password.hint")),s.createElement("div",{className:"envx-field-row","data-even":""},s.createElement(B,{label:o("field.privateKey")},s.createElement(A,{value:w.privateKeyPath,onChange:g=>U("privateKeyPath",g),placeholder:o("field.privateKey.ph"),mono:!0})),s.createElement(B,{label:o("field.passphrase")},s.createElement(A,{value:w.passphrase,onChange:g=>U("passphrase",g),type:"password"}))),s.createElement(B,{label:o("field.cwd")},s.createElement(A,{value:w.cwd,onChange:g=>U("cwd",g),placeholder:"/home/me/project",mono:!0})),s.createElement(B,{label:o("field.serverPath"),hint:o("field.serverPath.hint")},s.createElement(A,{value:w.serverPath,onChange:g=>U("serverPath",g),placeholder:"/usr/local/bin/dsh-env-server",mono:!0}))),a==="adb"&&s.createElement(B,{label:o("field.serial"),hint:o("field.serial.hint")},s.createElement(A,{value:w.serial,onChange:g=>U("serial",g),placeholder:"emulator-5554",mono:!0})),a==="winuser"&&s.createElement(s.Fragment,null,s.createElement(B,{label:o("field.account"),hint:o(d?"field.account.hint":"field.account.hint.create")},s.createElement(A,{value:w.account,disabled:d,onChange:g=>U("account",g.replace(/[^A-Za-z0-9_-]/g,"").slice(0,20)),placeholder:"dsh-test",mono:!0})),s.createElement(Ts,{value:w.desktop??"shared",onChange:g=>h(K=>({...K,desktop:g})),session:Te,platform:r,t:o})),s.createElement(tn,{title:o("more.title"),summary:ee?void 0:Xn,open:ee,onToggle:()=>oe(g=>!g)},s.createElement(B,{label:o("field.description")},s.createElement(A,{value:R,onChange:k})),s.createElement("div",{className:"envx-switch-row"},s.createElement("div",null,s.createElement("span",null,o("field.headlessParallel")),s.createElement("small",null,o("field.headlessParallel.hint"))),s.createElement(F.Switch,{checked:T,onChange:v,label:o("field.headlessParallel")})),s.createElement(B,{label:o("field.mountMode"),hint:o("field.mountMode.hint")},s.createElement("select",{className:"envx-input",value:D,onChange:g=>te(g.target.value==="gui"||g.target.value==="headless"?g.target.value:"")},s.createElement("option",{value:""},o("field.mountMode.default",{mode:o(`mode.${i??"headless"}`)})),s.createElement("option",{value:"headless"},o("mode.headless")," \xB7 ",o("mode.headless.desc")),s.createElement("option",{value:"gui"},o("mode.gui")," \xB7 ",o("mode.gui.desc"))))),X&&s.createElement("div",{className:"envx-result","data-ok":String(X.ok)},X.ok?s.createElement(re,{size:16}):null,s.createElement("span",null,X.text)),W&&!X&&a!=="reverse"&&s.createElement("div",{className:"envx-result","data-ok":"pending"},s.createElement(L,{size:16}),s.createElement("span",null,o("action.testing")))))}function Is({value:e,onChange:n,locked:t,t:r}){let i=[{kind:"server",key:"direct"},{kind:"reverse",key:"reverse"}],p=o=>{if(t||!["ArrowLeft","ArrowRight","ArrowUp","ArrowDown"].includes(o.key))return;o.preventDefault();let d=e==="server"?"reverse":"server";n(d),o.currentTarget.parentElement?.querySelector(`[data-dir='${d}']`)?.focus()};return s.createElement("div",{className:"envx-field"},s.createElement("label",{id:"envx-direction-label"},r("field.direction")),s.createElement("div",{className:"envx-modes","data-cols":"2",role:"radiogroup","aria-labelledby":"envx-direction-label"},i.map(({kind:o,key:d})=>{let a=e===o;return s.createElement("button",{key:o,type:"button",role:"radio","aria-checked":a,tabIndex:a?0:-1,className:"envx-mode envx-dir","data-dir":o,"data-on":a?"":void 0,disabled:t&&!a,title:t&&!a?r("direction.locked"):void 0,onClick:()=>n(o),onKeyDown:p},s.createElement("span",{className:"envx-flow","data-dir":o,"aria-hidden":"true"},s.createElement("span",{className:"envx-flow-node"},s.createElement(Ze,{size:14}),r("direction.this")),s.createElement("span",{className:"envx-flow-arrow"},s.createElement(En,{size:16})),s.createElement("span",{className:"envx-flow-node"},s.createElement(He,{size:14}),r("direction.target"))),s.createElement("strong",null,r(`direction.${d}`)),s.createElement("span",null,r(`direction.${d}.desc`)))})))}function Cs({config:e,set:n,addr:t,onAddr:r,editing:i,t:p}){let[o,d]=(0,M.useState)(!i),a=String(e.port||7461);return s.createElement(s.Fragment,null,s.createElement("div",{className:"envx-field"},s.createElement("div",{className:"envx-field-head"},s.createElement("label",null,p("field.address")),s.createElement(F.SegmentedControl,{id:"envx-addr",className:"envx-seg",value:t,label:p("field.address"),options:[{value:"host",label:p("address.hostPort")},{value:"url",label:p("address.url")}],onChange:r})),t==="host"?s.createElement("div",{className:"envx-field-row"},s.createElement(A,{value:e.host,onChange:u=>n("host",u.trim()),placeholder:"192.168.1.20","aria-label":p("field.host"),mono:!0}),s.createElement(A,{value:e.port,onChange:u=>n("port",u.replace(/\D/g,"")),inputMode:"numeric",placeholder:"7461","aria-label":p("field.port"),mono:!0})):s.createElement(s.Fragment,null,s.createElement(A,{value:e.url,onChange:u=>n("url",u.trim()),placeholder:"wss://env.example.com/dsh-env","aria-label":p("field.url"),mono:!0}),s.createElement("small",null,p("field.url.hint")))),s.createElement(B,{label:p("field.token"),hint:p("field.token.hint")},s.createElement(A,{value:e.token,onChange:u=>n("token",u),type:"password",mono:!0})),s.createElement(tn,{title:p("server.help.title"),open:o,onToggle:()=>d(u=>!u)},s.createElement("p",{className:"envx-disc-text"},p("server.help.body")),s.createElement(_e,{label:p("server.help.tcp"),text:`dsh-env-server serve --listen 0.0.0.0:${a} --token-file token.txt`,t:p}),s.createElement(_e,{label:p("server.help.ws"),text:`dsh-env-server serve --listen ws://127.0.0.1:${a}/dsh-env --token-file token.txt`,t:p})))}var qe=[{mode:"shared",Icon:Tn},{mode:"private",Icon:zn},{mode:"session",Icon:Ke}];function Ts({value:e,onChange:n,session:t,platform:r,t:i}){let p=(o,d)=>{let a=o.key==="ArrowRight"||o.key==="ArrowDown"?1:o.key==="ArrowLeft"||o.key==="ArrowUp"?-1:0;if(!a)return;o.preventDefault();let u=qe[(d+a+qe.length)%qe.length];if(!u)return;n(u.mode),o.currentTarget.parentElement?.querySelector(`[data-mode='${u.mode}']`)?.focus()};return s.createElement("div",{className:"envx-field"},s.createElement("label",{id:"envx-desktop-label"},i("field.desktop")),s.createElement("div",{className:"envx-modes",role:"radiogroup","aria-labelledby":"envx-desktop-label"},qe.map(({mode:o,Icon:d},a)=>{let u=e===o;return s.createElement("button",{key:o,type:"button",role:"radio","aria-checked":u,tabIndex:u?0:-1,className:"envx-mode","data-mode":o,"data-on":u?"":void 0,onClick:()=>n(o),onKeyDown:y=>p(y,a)},s.createElement("span",{className:"envx-mode-top"},s.createElement(d,{size:18}),o==="session"&&t.status&&t.phase!=="ready"&&s.createElement(sn,{t:i,state:t})),s.createElement("strong",null,i(`desktop.mode.${o}`)),s.createElement("span",null,i(`desktop.mode.${o}.desc`)))})),e==="session"&&!t.ready&&s.createElement(Bn,{t:i,platform:r,variant:"inline",footnote:i("desktop.mode.session.notReady")}))}function zs(e){let[n,t]=(0,M.useState)(void 0),[r,i]=(0,M.useState)({}),[p,o]=(0,M.useState)("{}"),[d,a]=(0,M.useState)(!1),[u,y]=(0,M.useState)(void 0),m=f=>{t(f.status),i(f.settings),o(JSON.stringify(f.settings))};(0,M.useEffect)(()=>{if(!e)return;let f=!0;return y(void 0),E("reverse.settings",{}).then(C=>f&&m(C),C=>f&&y(H(C))),()=>{f=!1}},[e]);let I=JSON.stringify(r)!==p,c=async f=>{a(!0),y(void 0);try{m(await E("reverse.settings",{settings:f})),O()}catch(C){throw y(H(C)),C}finally{a(!1)}};return{status:n,settings:r,setSettings:i,dirty:I,busy:d,error:u,apply:()=>c(r).catch(()=>{}),ensure:async()=>{if(!n)return;let f=!!r.tcp?.enabled||!!r.ws?.enabled;f&&!I||await c(f?r:{...r,tcp:{...r.tcp,enabled:!0}})}}}function Rs(e){let n=e?.connection;return n&&n.idle+n.active>0?n:void 0}function Kn({env:e,t:n}){let t=Rs(e);return s.createElement("div",{className:"envx-live","data-state":t?"ok":"wait",role:"status"},t?s.createElement("i",null):s.createElement(L,{size:14}),s.createElement("span",null,t?n("reverse.connected",{peer:t.peer??"",active:t.active}):n("reverse.waiting")))}function Es({reveal:e,env:n,t}){let[r,i]=(0,M.useState)("posix"),p=r==="windows"?e.windows:e.posix;return s.createElement(s.Fragment,null,s.createElement("div",{className:"envx-step"},s.createElement("span",{className:"envx-step-icon"},s.createElement(Oe,{size:16})),s.createElement("div",null,s.createElement("strong",null,t("reverse.command.title")),s.createElement("span",null,e.posix?t("reverse.command.body"):t("reverse.command.noListener")))),(e.posix||e.windows)&&s.createElement("div",{className:"envx-field"},s.createElement(F.SegmentedControl,{id:"envx-os",className:"envx-seg",value:r,label:t("reverse.command.title"),options:[{value:"posix",label:t("reverse.command.posix")},{value:"windows",label:t("reverse.command.windows")}],onChange:i}),p&&s.createElement(_e,{text:p,t})),s.createElement(_e,{label:t("reverse.secret"),text:e.secret,t}),s.createElement(Kn,{env:n,t}))}function Ps({environment:e,editing:n,listeners:t,onReveal:r,t:i,children:p}){let{status:o,settings:d,setSettings:a}=t,[u,y]=(0,M.useState)(!1),[m,I]=(0,M.useState)(!1),[c,f]=(0,M.useState)(void 0),C=async()=>{if(e){I(!0),f(void 0);try{await t.ensure(),r((await E("reverse.rotate",{id:e.id})).reverse),O()}catch(T){f(H(T))}finally{I(!1)}}},R=d.tcp??{},k=d.ws??{},w=T=>{let v=T.replace(/\D/g,"");return v?Number(v):void 0},h=T=>T?.enabled?T.listening?i("reverse.listener.on",{port:T.port}):T.error??"":i("reverse.listener.off"),z=o?[["TCP",o.tcp],["WebSocket",o.ws]].filter(([,T])=>T.enabled&&!T.listening&&T.error):[],$=o?z.length?s.createElement("span",{"data-tone":"error"},z.map(([T,v])=>i("reverse.listener.failed",{proto:T,error:v.error??""})).join(" \xB7 ")):!o.tcp.enabled&&!o.ws.enabled?s.createElement("span",{"data-tone":"warn"},i("reverse.listener.autoTcp",{port:R.port??7462})):s.createElement("span",null,[o.tcp.enabled?`TCP :${o.tcp.port}`:"",o.ws.enabled?`WebSocket :${o.ws.port}${o.ws.path??""}`:""].filter(Boolean).join(" \xB7 ")," \u2192 ",o.publicHost):s.createElement(L,{size:12});return s.createElement(s.Fragment,null,n&&s.createElement(Kn,{env:e,t:i}),p,s.createElement(tn,{title:i("reverse.listener.title"),summary:u?void 0:$,open:u,onToggle:()=>y(T=>!T)},s.createElement("p",{className:"envx-disc-text"},i("reverse.listener.body")),s.createElement("div",{className:"envx-switch-row"},s.createElement("div",null,s.createElement("span",null,"TCP"),s.createElement("small",null,h(o?.tcp))),s.createElement(F.Switch,{checked:!!R.enabled,onChange:T=>a(v=>({...v,tcp:{...v.tcp,enabled:T}})),label:"TCP"})),R.enabled&&s.createElement("div",{className:"envx-field-row","data-even":""},s.createElement(B,{label:i("reverse.bind")},s.createElement(A,{value:R.host,onChange:T=>a(v=>({...v,tcp:{...v.tcp,host:T}})),placeholder:"0.0.0.0",mono:!0})),s.createElement(B,{label:i("field.port")},s.createElement(A,{value:R.port,onChange:T=>a(v=>({...v,tcp:{...v.tcp,port:w(T)}})),inputMode:"numeric",placeholder:"7462",mono:!0}))),s.createElement("div",{className:"envx-switch-row"},s.createElement("div",null,s.createElement("span",null,"WebSocket"),s.createElement("small",null,h(o?.ws))),s.createElement(F.Switch,{checked:!!k.enabled,onChange:T=>a(v=>({...v,ws:{...v.ws,enabled:T}})),label:"WebSocket"})),k.enabled&&s.createElement("div",{className:"envx-field-row","data-three":""},s.createElement(B,{label:i("reverse.bind")},s.createElement(A,{value:k.host,onChange:T=>a(v=>({...v,ws:{...v.ws,host:T}})),placeholder:"0.0.0.0",mono:!0})),s.createElement(B,{label:i("field.port")},s.createElement(A,{value:k.port,onChange:T=>a(v=>({...v,ws:{...v.ws,port:w(T)}})),inputMode:"numeric",placeholder:"7463",mono:!0})),s.createElement(B,{label:i("reverse.path")},s.createElement(A,{value:k.path,onChange:T=>a(v=>({...v,ws:{...v.ws,path:T}})),placeholder:"/dsh-env",mono:!0}))),s.createElement(B,{label:i("reverse.publicHost"),hint:i("reverse.publicHost.hint",{host:o?.publicHost??""})},s.createElement(A,{value:d.publicHost,onChange:T=>a(v=>({...v,publicHost:T})),placeholder:o?.publicHost,mono:!0})),t.dirty&&s.createElement("div",{className:"envx-inline-actions"},s.createElement("span",null,i("reverse.listener.dirty")),s.createElement(F.Button,{variant:"outline",size:"sm",disabled:t.busy,icon:t.busy?s.createElement(L,{size:14}):void 0,onClick:()=>{t.apply()}},i("action.apply")))),n?s.createElement("div",{className:"envx-step"},s.createElement("span",{className:"envx-step-icon"},s.createElement(Oe,{size:16})),s.createElement("div",null,s.createElement("strong",null,i("reverse.command.title")),s.createElement("span",null,i("reverse.command.again"))),s.createElement(F.Button,{variant:"outline",size:"sm",disabled:m||!e,icon:m?s.createElement(L,{size:14}):void 0,onClick:()=>{C()}},i("reverse.rotate"))):s.createElement("div",{className:"envx-step"},s.createElement("span",{className:"envx-step-icon"},s.createElement(Oe,{size:16})),s.createElement("div",null,s.createElement("strong",null,i("reverse.next.title")),s.createElement("span",null,i("reverse.next.body")))),(c||t.error)&&s.createElement("div",{className:"envx-result","data-ok":"false"},s.createElement("span",null,c??t.error)))}function On({open:e,title:n,body:t,confirmLabel:r,danger:i,onConfirm:p,onClose:o,t:d}){let[a,u]=(0,M.useState)(!1),[y,m]=(0,M.useState)(void 0);(0,M.useEffect)(()=>{e&&(u(!1),m(void 0))},[e]);let I=async()=>{u(!0),m(void 0);try{await p(),O(),o()}catch(c){m(H(c))}finally{u(!1)}};return s.createElement(F.Modal,{open:e,onClose:o,title:n,closeLabel:d("action.close"),className:"envx-dialog",footer:s.createElement("div",{className:"envx-footer"},s.createElement(F.Button,{variant:"ghost",onClick:o},d("action.cancel")),s.createElement(F.Button,{variant:"primary",disabled:a,onClick:()=>{I()},style:i?{background:"var(--dsw-alias-state-error-primary)"}:void 0},r))},s.createElement("p",{style:{margin:0,color:"var(--dsw-alias-label-secondary)",fontSize:13.5,lineHeight:"21px"}},t),y&&s.createElement("div",{className:"envx-result","data-ok":"false",style:{marginTop:12}},s.createElement("span",null,y)))}function Ms(e,n){let t=Date.now()-n;return t<6e4?e("time.justNow"):t<36e5?e("time.minutes",{n:Math.floor(t/6e4)}):e("time.hours",{n:Math.floor(t/36e5)})}function Ds(e){let n=e.config;switch(e.kind){case"server":return n.url||`${n.host}:${n.port}`;case"ssh":return`${n.username?`${n.username}@`:""}${n.host}${n.port&&Number(n.port)!==22?`:${n.port}`:""}`;case"adb":return n.serial;case"winuser":return n.account;case"reverse":return e.connection?.peer;default:return e.description}}function Vs(e,n){let t=e.status,r=t?.queue?.length?` \xB7 ${n("status.queue",{count:t.queue.length})}`:"";if(t?.busy){let i=t.holders?.[0]?.title;return{state:"busy",text:(i?n("status.busyBy",{who:i}):n("status.busy"))+r}}if(t?.gui){let i=t.gui.title??t.gui.sessionId?.slice(0,8)??"";return{state:"busy",text:n("status.guiBy",{who:i})+r}}if(e.kind==="reverse"){let i=e.connection;return i&&i.idle+i.active>0?{state:"ok",text:n("status.available"),...i.peer?{detail:i.peer}:{}}:{state:"idle",text:n("status.offline")}}return e.lastError?{state:"error",text:n("status.failed"),detail:e.lastError}:e.info||e.kind==="local"||e.discovered?{state:"ok",text:n("status.available")}:{state:"idle",text:n("status.unknown")}}function Ws({env:e,t:n,onEdit:t,onDelete:r,onWorkspace:i,onDesktop:p,sessionReady:o}){let d=ke(),a=Vs(e,n),u=[n(`kind.${e.kind}`),Ds(e)].filter(Boolean).join(" \xB7 "),y=e.info,m=!!y?.caps?.includes("screenshot");return l.createElement("article",{className:"envx-card","data-kind":e.kind},l.createElement("div",{className:"envx-card-head"},l.createElement("span",{className:"envx-tile","data-kind":e.kind},l.createElement(Z,{kind:e.kind})),l.createElement("div",{className:"envx-card-title"},l.createElement("strong",{title:se(e,n)},se(e,n)),l.createElement("span",{className:"envx-sub",title:u},u)),l.createElement("span",{className:"envx-status","data-state":a.state,title:a.detail??a.text},l.createElement("i",null),a.text)),l.createElement("div",{className:"envx-meta"},l.createElement("span",{className:"envx-chip"},l.createElement("code",null,e.alias)),y&&l.createElement("span",{className:"envx-chip"},n("info.os",{os:y.os,arch:y.arch||"\u2014"})),y?.user&&l.createElement("span",{className:"envx-chip"},y.user),l.createElement("span",{className:"envx-chip"},e.headlessParallel?n("status.shared"):n("status.exclusive")),e.effectiveMountMode==="gui"&&l.createElement("span",{className:"envx-chip"},n("field.mountMode")," \xB7 ",n("mode.gui")),e.kind==="winuser"&&l.createElement("span",{className:"envx-chip","data-tone":e.config.desktop==="shared"?void 0:"accent"},e.config.desktop==="private"?n("desktop.mode.private"):e.config.desktop==="session"?n("desktop.mode.session"):n("desktop.mode.shared")),e.discovered&&l.createElement("span",{className:"envx-chip","data-tone":"accent"},n("status.discovered")),e.builtin&&l.createElement("span",{className:"envx-chip"},n("status.builtin"))),e.kind==="winuser"&&e.config.desktop==="session"&&o===!1&&l.createElement("div",{className:"envx-card-notice"},l.createElement("span",null,n("desktop.card.notReady")),l.createElement("button",{type:"button",className:"envx-textbtn",onClick:()=>t(e)},n("desktop.card.setup"))),(d.error||a.state==="error"&&a.detail)&&l.createElement("div",{className:"envx-error-line"},d.error??a.detail),l.createElement("div",{className:"envx-card-foot"},l.createElement("button",{type:"button",className:"envx-linkbtn",onClick:()=>i(e)},l.createElement(Se,{size:14}),n("action.newWorkspace")),l.createElement("button",{type:"button",className:"envx-linkbtn",disabled:d.busy,onClick:()=>{d.run(async()=>{let I=await E("test",{id:e.id});if(!I.ok)throw new Error(I.error)})}},d.busy?l.createElement(L,{size:14}):l.createElement(Sn,{size:14}),d.busy?n("action.testing"):n("action.test")),l.createElement("span",{className:"envx-card-tools"},m&&l.createElement(ce.Tooltip,{label:n("action.viewDesktop"),side:"top"},l.createElement("button",{type:"button",className:"envx-iconbtn","aria-label":n("action.viewDesktop"),onClick:()=>p(e)},l.createElement(Nn,{size:16}))),e.discovered&&l.createElement(ce.Tooltip,{label:n("action.addDevice"),side:"top"},l.createElement("button",{type:"button",className:"envx-iconbtn","aria-label":n("action.addDevice"),onClick:()=>{E("save",{environment:{id:e.id,name:e.name,kind:"adb",config:e.config,description:e.description}}).then(O)}},l.createElement(he,{size:16}))),!e.builtin&&!e.discovered&&l.createElement(l.Fragment,null,l.createElement(ce.Tooltip,{label:n("action.edit"),side:"top"},l.createElement("button",{type:"button",className:"envx-iconbtn","aria-label":n("action.edit"),onClick:()=>t(e)},l.createElement(kn,{size:16}))),l.createElement(ce.Tooltip,{label:n("action.delete"),side:"top"},l.createElement("button",{type:"button",className:"envx-iconbtn","data-danger":"","aria-label":n("action.delete"),onClick:()=>r(e)},l.createElement(Qe,{size:16})))))))}function jn({t:e,startSession:n}){let{data:t,error:r,loading:i,refresh:p}=Le(void 0,{discover:!0}),[o,d]=(0,on.useState)(void 0),[a,u]=(0,on.useState)(void 0),y=ke(),m=t?.environments??[],I=Object.fromEntries(m.map(h=>[h.id,h])),c=t?.remoteWorkspaces??[],f=t?.leases??[],C=m.some(h=>h.kind==="winuser"&&h.config.desktop==="session"),R=Ee(C?t?.platform:void 0),k=(h,z)=>{d(void 0),z&&h.workspaceId&&n(h.workspaceId)},w=o?.type==="delete"?o.environment:void 0;return l.createElement("div",{className:"envx-page"},l.createElement("div",{className:"envx-scroll"},l.createElement("div",{className:"envx-content"},l.createElement("header",{className:"envx-heading"},l.createElement("div",null,l.createElement("h1",null,e("page.title")),l.createElement("p",null,e("page.subtitle"))),l.createElement("div",{className:"envx-actions"},l.createElement(ce.Tooltip,{label:e("action.refresh"),side:"bottom"},l.createElement("button",{type:"button",className:"envx-iconbtn","aria-label":e("action.refresh"),onClick:()=>{y.run(async()=>{await E("state",{discover:!0}),p()})}},y.busy||i&&!t?l.createElement(L,{size:16}):l.createElement(Ne,{size:16}))),l.createElement(ce.Button,{variant:"primary",icon:l.createElement(he,{size:16}),onClick:()=>d({type:"env"})},e("action.add")))),r&&l.createElement("div",{className:"envx-banner"},e("err.generic",{message:r})),t?.discovered.adbError&&m.some(h=>h.kind==="adb")&&l.createElement("div",{className:"envx-banner","data-tone":"info"},e("adb.error",{message:t.discovered.adbError})),l.createElement("section",{className:"envx-section"},l.createElement("div",{className:"envx-section-head"},l.createElement("h2",null,e("section.environments"),l.createElement("span",{className:"envx-count"},m.length))),l.createElement("div",{className:"envx-grid"},m.map(h=>l.createElement(Ws,{key:h.id,env:h,t:e,sessionReady:R.status?R.ready:void 0,onEdit:z=>d({type:"env",environment:z}),onDelete:z=>d({type:"delete",environment:z}),onWorkspace:z=>d({type:"browser",envId:z.id}),onDesktop:u})),l.createElement("button",{type:"button",className:"envx-card envx-kind","data-dashed":"",style:{alignItems:"center",justifyContent:"center",minHeight:132,flexDirection:"column",gap:6,color:"var(--dsw-alias-label-tertiary)"},onClick:()=>d({type:"env"})},l.createElement(he,{size:20}),l.createElement("span",{style:{fontSize:13}},e("action.add"))))),l.createElement("section",{className:"envx-section"},l.createElement("div",{className:"envx-section-head"},l.createElement("div",null,l.createElement("h2",null,e("section.workspaces"),l.createElement("span",{className:"envx-count"},c.length)),l.createElement("p",null,e("section.workspaces.hint"))),l.createElement("button",{type:"button",className:"envx-linkbtn",onClick:()=>d({type:"browser"})},l.createElement(he,{size:14}),e("action.newWorkspace"))),c.length===0?l.createElement("div",{className:"envx-empty"},e("section.workspaces.empty")):l.createElement("div",{className:"envx-list"},c.map(h=>{let z=I[h.envId],$=h.workspaceId;return l.createElement("div",{className:"envx-row",key:h.id,"data-kind":z?.kind??"server"},l.createElement("span",{className:"envx-tile","data-kind":z?.kind??"server"},l.createElement(Se,{size:18})),l.createElement("div",{className:"envx-row-main"},l.createElement("strong",null,h.title),l.createElement("span",{title:h.root},e("ws.root",{env:z?.name??h.envId,root:h.root}))),$&&l.createElement("button",{type:"button",className:"envx-linkbtn",onClick:()=>n($)},e("action.newSession")),l.createElement(ce.Tooltip,{label:e("action.remove"),side:"top"},l.createElement("button",{type:"button",className:"envx-iconbtn","data-danger":"","aria-label":e("action.remove"),onClick:()=>{E("remoteWorkspace.delete",{id:h.id}).then(O)}},l.createElement(Qe,{size:16}))))}))),l.createElement("section",{className:"envx-section"},l.createElement("div",{className:"envx-section-head"},l.createElement("h2",null,e("section.leases"),l.createElement("span",{className:"envx-count"},f.length))),f.length===0?l.createElement("div",{className:"envx-empty"},e("section.leases.empty")):l.createElement("div",{className:"envx-list"},f.map(h=>{let z=I[h.envId];return l.createElement("div",{className:"envx-row",key:h.id,"data-kind":z?.kind??"server"},l.createElement("span",{className:"envx-tile","data-kind":z?.kind??"server"},l.createElement(Z,{kind:z?.kind,size:18})),l.createElement("div",{className:"envx-row-main"},l.createElement("strong",null,z?se(z,e):h.name),l.createElement("span",null,e("lease.session",{id:String(h.owner?.sessionId??"").replace(/^session-/,"").slice(0,8)})," \xB7 ",Ms(e,h.createdAt),h.owner?.reason?` \xB7 ${h.owner.reason}`:"",h.tunnels?.length?` \xB7 ${e("lease.tunnels",{count:h.tunnels.length})}`:"",h.mode==="gui"&&h.guiUsers?.some($=>$!==h.owner?.sessionId)?` \xB7 ${e("lease.guiUsers",{ids:h.guiUsers.map($=>$.replace(/^session-/,"").slice(0,8)).join(", ")})}`:"")),l.createElement("span",{className:"envx-chip","data-tone":h.mode==="gui"?"accent":void 0},h.mode==="gui"?e("mode.gui"):e("mode.headless")),l.createElement("span",{className:"envx-chip","data-tone":h.purpose==="mount"?"accent":void 0},h.purpose==="mount"?e("badge.mount"):e("badge.borrow")),l.createElement("button",{type:"button",className:"envx-linkbtn",onClick:()=>{E("lease.release",{leaseId:h.id}).then(O)}},e("action.release")))}))))),l.createElement(Fn,{open:o?.type==="env",environment:o?.type==="env"?o.environment:void 0,environments:m,platform:t?.platform,defaultMountMode:t?.defaults?.mountMode,onClose:()=>d(void 0),t:e}),l.createElement(On,{open:o?.type==="delete",title:e("dialog.delete.title"),body:w?.kind==="winuser"?e("dialog.account.delete",{name:w.config.account??""}):e("dialog.delete.body",{name:w?.name??""}),confirmLabel:e("action.delete"),danger:!0,onConfirm:()=>w?w.kind==="winuser"?E("winuser.delete",{name:w.config.account}):E("delete",{id:w.id}):Promise.resolve(),onClose:()=>d(void 0),t:e}),l.createElement(je,{open:o?.type==="browser",mode:"workspace",environments:m,initialEnvId:o?.type==="browser"?o.envId:void 0,onClose:()=>d(void 0),onCreated:k,t:e}),a&&l.createElement(Vn,{env:I[a.id]??a,t:e,onClose:()=>u(void 0)}))}var Un=`.envx-page,
.envx-dialog {
  --envx-warn: var(--dsw-alias-state-warn-primary, #d98a0b);
}
.envx-page {
  display: flex;
  width: 100%;
  height: 100%;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
  color: var(--dsw-alias-label-primary);
  background: var(--dsw-alias-bg-base);
  font-size: 14px;
  line-height: 1.6;
}
.envx-scroll {
  flex: 1;
  min-height: 0;
  overflow: auto;
  scrollbar-gutter: stable;
}
.envx-content {
  max-width: 1040px;
  margin: 0 auto;
  padding: 0 clamp(24px, 4vw, 48px) 64px;
}
.envx-heading {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: 16px;
  padding-top: 28px;
  margin-bottom: 28px;
}
.envx-heading h1 {
  margin: 0;
  font-size: 22px;
  line-height: 30px;
  font-weight: 600;
  letter-spacing: -0.01em;
}
.envx-heading p {
  margin: 4px 0 0;
  color: var(--dsw-alias-label-secondary);
  font-size: 13px;
  line-height: 20px;
}
.envx-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;
}
.envx-section {
  margin-top: 32px;
}
.envx-section:first-of-type {
  margin-top: 0;
}
.envx-section-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 12px;
}
.envx-section-head h2 {
  margin: 0;
  font-size: 14px;
  line-height: 22px;
  font-weight: 600;
}
.envx-section-head p {
  margin: 2px 0 0;
  color: var(--dsw-alias-label-tertiary);
  font-size: 12px;
  line-height: 18px;
  max-width: 640px;
}
.envx-count {
  margin-left: 8px;
  color: var(--dsw-alias-label-tertiary);
  font-weight: 400;
  font-variant-numeric: tabular-nums;
}
.envx-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
  gap: 12px;
}

.envx-card {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: 12px;
  min-width: 0;
  padding: 16px;
  border-radius: 14px;
  border: 0.5px solid var(--dsw-alias-border-l2);
  background: var(--dsw-alias-bg-layer-1);
  transition:
    border-color 0.15s,
    box-shadow 0.15s;
}
.envx-card:hover {
  border-color: var(--dsw-alias-border-l3);
  box-shadow: 0 4px 18px color-mix(in srgb, var(--dsw-alias-label-primary) 6%, transparent);
}
.envx-card[data-dashed] {
  border-style: dashed;
  background: transparent;
}
.envx-card-head {
  display: flex;
  align-items: flex-start;
  gap: 12px;
  min-width: 0;
}
.envx-tile {
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 38px;
  height: 38px;
  border-radius: 10px;
  color: var(--envx-accent);
  background: color-mix(in srgb, var(--envx-accent) 13%, transparent);
}
[data-kind='local'] {
  --envx-accent: #4b83f0;
}
[data-kind='server'],
[data-kind='reverse'] {
  --envx-accent: #8b6cf0;
}
[data-kind='ssh'] {
  --envx-accent: #16a37b;
}
[data-kind='adb'] {
  --envx-accent: #3dba54;
}
[data-kind='winuser'] {
  --envx-accent: #1e9bd7;
}
.envx-card-title {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
}
.envx-card-title strong {
  font-size: 14px;
  line-height: 20px;
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.envx-sub {
  color: var(--dsw-alias-label-tertiary);
  font-size: 12px;
  line-height: 18px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.envx-status {
  flex: none;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 22px;
  padding: 0 8px 0 6px;
  border-radius: 11px;
  font-size: 12px;
  line-height: 18px;
  color: var(--dsw-alias-label-secondary);
  background: var(--dsw-alias-bg-layer-2);
  white-space: nowrap;
  max-width: 46%;
  overflow: hidden;
  text-overflow: ellipsis;
}
.envx-status i {
  flex: none;
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--dsw-alias-label-dimmed, #aaa);
}
.envx-status[data-state='ok'] i {
  background: var(--dsw-alias-state-success-primary);
}
.envx-status[data-state='busy'] {
  color: var(--dsw-alias-state-warn-label, var(--dsw-alias-label-primary));
  background: color-mix(in srgb, var(--dsw-alias-state-warn-primary) 14%, transparent);
}
.envx-status[data-state='busy'] i {
  background: var(--dsw-alias-state-warn-primary);
}
.envx-status[data-state='error'] {
  color: var(--dsw-alias-state-error-primary);
  background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 10%, transparent);
}
.envx-status[data-state='error'] i {
  background: var(--dsw-alias-state-error-primary);
}
.envx-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  min-height: 22px;
  align-items: center;
}
.envx-chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: 22px;
  padding: 0 8px;
  border-radius: 6px;
  font-size: 12px;
  line-height: 18px;
  color: var(--dsw-alias-label-secondary);
  background: var(--dsw-alias-bg-layer-2);
  white-space: nowrap;
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
}
.envx-chip[data-tone='accent'] {
  color: var(--dsw-alias-state-business-primary);
  background: color-mix(in srgb, var(--dsw-alias-state-business-primary) 10%, transparent);
}
.envx-chip[data-tone='warn'] {
  color: var(--envx-warn);
  background: color-mix(in srgb, var(--envx-warn) 12%, transparent);
}

/* ---- separate-session mode: readiness panel (page) and inline setup (account dialog) ---- */
.envx-sess {
  display: flex;
  flex-direction: column;
  gap: 10px;
  margin-bottom: 12px;
  padding: 12px 14px 12px 16px;
  border-radius: 14px;
  border: 0.5px solid var(--dsw-alias-border-l2);
  background: var(--dsw-alias-bg-layer-1);
}
.envx-sess[data-variant='inline'] {
  margin: 4px 0 0;
  padding: 10px 12px;
  border-radius: 10px;
  border-color: transparent;
  background: color-mix(in srgb, var(--envx-warn) 8%, transparent);
}
.envx-sess[data-variant='inline'][data-phase='reboot'],
.envx-sess[data-variant='inline'][data-phase='probing'] {
  background: color-mix(in srgb, var(--dsw-alias-label-primary) 4%, transparent);
}
.envx-sess[data-variant='panel'][data-phase='install'],
.envx-sess[data-variant='panel'][data-phase='enable'],
.envx-sess[data-variant='panel'][data-phase='manual'] {
  border-color: color-mix(in srgb, var(--envx-warn) 35%, var(--dsw-alias-border-l2));
}
.envx-sess-head {
  display: flex;
  align-items: center;
  gap: 12px;
  min-width: 0;
}
.envx-sess-head .envx-tile {
  width: 34px;
  height: 34px;
  border-radius: 9px;
}
.envx-sess-main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
}
.envx-sess-title {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}
.envx-sess-title strong {
  font-size: 13.5px;
  line-height: 20px;
  font-weight: 600;
  white-space: nowrap;
}
.envx-sess-line {
  color: var(--dsw-alias-label-secondary);
  font-size: 12.5px;
  line-height: 19px;
}
.envx-sess-actions {
  flex: none;
  display: flex;
  align-items: center;
  gap: 6px;
}
.envx-sess-toggle {
  appearance: none;
  display: inline-flex;
  align-items: center;
  gap: 2px;
  height: 28px;
  padding: 0 6px 0 8px;
  border: none;
  border-radius: 8px;
  background: transparent;
  color: var(--dsw-alias-label-tertiary);
  font: inherit;
  font-size: 12.5px;
  cursor: pointer;
}
.envx-sess-toggle:hover {
  color: var(--dsw-alias-label-primary);
  background: var(--dsw-alias-interactive-bg-hover);
}
.envx-sess-toggle svg {
  transition: transform 0.15s;
}
.envx-sess-toggle[aria-expanded='true'] svg {
  transform: rotate(90deg);
}
.envx-sess-note {
  margin: -4px 0 0;
  color: var(--dsw-alias-label-tertiary);
  font-size: 12px;
  line-height: 17px;
}
.envx-sess[data-variant='panel'] .envx-sess-note,
.envx-sess[data-variant='panel'] > .envx-card-notice {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 6px 6px 10px;
  border-radius: 8px;
  font-size: 12px;
  line-height: 17px;
  color: var(--envx-warn);
  background: color-mix(in srgb, var(--envx-warn) 9%, transparent);
}
.envx-card-notice span {
  flex: 1;
  min-width: 0;
}
.envx-card-notice .envx-textbtn {
  flex: none;
}
.envx-error-line {
  padding-left: 46px;
}
.envx-sess-body {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding-top: 10px;
  border-top: 0.5px solid var(--dsw-alias-border-l1);
}
.envx-sess[data-variant='panel'] .envx-sess-body {
  margin-left: 46px;
}
.envx-sess-purpose {
  margin: 0;
  color: var(--dsw-alias-label-secondary);
  font-size: 12.5px;
  line-height: 19px;
}
.envx-sess-checks {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
  gap: 6px 16px;
  margin: 0;
  padding: 0;
  list-style: none;
}
.envx-sess-checks li {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  font-size: 12.5px;
  line-height: 18px;
  color: var(--dsw-alias-label-primary);
}
.envx-sess-checks li span {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.envx-sess-checks i {
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 15px;
  height: 15px;
  border-radius: 50%;
  box-sizing: border-box;
  border: 1.5px solid color-mix(in srgb, var(--envx-warn) 70%, transparent);
}
.envx-sess-checks li[data-ok] {
  color: var(--dsw-alias-label-tertiary);
}
.envx-sess-checks li[data-ok] i {
  border: none;
  color: #fff;
  background: var(--dsw-alias-state-success-primary);
}
.envx-sess-checks li[data-ok] svg {
  stroke-width: 2.6;
}
.envx-sess-foot {
  display: flex;
  align-items: flex-end;
  gap: 12px;
  color: var(--dsw-alias-label-tertiary);
  font-size: 12px;
  line-height: 17px;
}
.envx-sess-foot > span {
  flex: 1;
  min-width: 0;
}
.envx-sess-foot .envx-textbtn {
  flex: none;
}
.envx-sess-badge {
  flex: none;
  display: inline-flex;
  align-items: center;
  gap: 5px;
  height: 18px;
  padding: 0 7px 0 6px;
  border-radius: 9px;
  font-size: 11px;
  line-height: 16px;
  font-weight: 500;
  white-space: nowrap;
  color: var(--dsw-alias-label-secondary);
  background: var(--dsw-alias-bg-layer-2);
}
.envx-sess-badge i {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: currentColor;
}
.envx-sess-badge[data-tone='ok'] {
  color: var(--dsw-alias-state-success-primary);
  background: color-mix(in srgb, var(--dsw-alias-state-success-primary) 11%, transparent);
}
.envx-sess-badge[data-tone='warn'] {
  color: var(--envx-warn);
  background: color-mix(in srgb, var(--envx-warn) 13%, transparent);
}
.envx-sess-badge[data-tone='info'] {
  color: var(--dsw-alias-state-business-primary);
  background: color-mix(in srgb, var(--dsw-alias-state-business-primary) 11%, transparent);
}
.envx-sess-badge[data-tone='error'] {
  color: var(--dsw-alias-state-error-primary);
  background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 10%, transparent);
}

/* desktop mode picker in the Windows-account dialog */
.envx-modes {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 8px;
}
.envx-mode {
  appearance: none;
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 2px;
  min-width: 0;
  padding: 10px 12px 11px;
  border-radius: 10px;
  border: 0.5px solid var(--dsw-alias-border-l3);
  background: var(--dsw-alias-bg-base);
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: pointer;
  transition:
    border-color 0.12s,
    background 0.12s,
    box-shadow 0.12s;
}
.envx-mode:hover {
  border-color: var(--dsw-alias-border-l4, var(--dsw-alias-border-l3));
  background: var(--dsw-alias-interactive-bg-hover);
}
.envx-mode:focus-visible {
  outline: none;
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--dsw-alias-state-business-primary) 22%, transparent);
}
.envx-mode[data-on] {
  border-color: var(--dsw-alias-state-business-primary);
  background: color-mix(in srgb, var(--dsw-alias-state-business-primary) 6%, var(--dsw-alias-bg-base));
  box-shadow: inset 0 0 0 0.5px var(--dsw-alias-state-business-primary);
}
.envx-mode-top {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
  width: 100%;
  height: 22px;
  margin-bottom: 4px;
  color: var(--dsw-alias-label-tertiary);
}
.envx-mode[data-on] .envx-mode-top {
  color: var(--dsw-alias-state-business-primary);
}
.envx-mode strong {
  font-size: 13px;
  line-height: 19px;
  font-weight: 600;
}
.envx-mode > span:last-child {
  color: var(--dsw-alias-label-tertiary);
  font-size: 11.5px;
  line-height: 16px;
}
.envx-modes[data-cols='2'] {
  grid-template-columns: repeat(2, 1fr);
}
.envx-mode:disabled {
  cursor: not-allowed;
  opacity: 0.45;
}
.envx-mode:disabled:hover {
  border-color: var(--dsw-alias-border-l3);
  background: var(--dsw-alias-bg-base);
}
.envx-dir {
  padding: 12px 14px 13px;
  gap: 3px;
}

/* connection direction diagram: This PC \u2192 Target, mirrored for reverse */
.envx-flow {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  margin-bottom: 8px;
  color: var(--dsw-alias-label-tertiary);
}
.envx-flow-node {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: 22px;
  padding: 0 7px;
  border-radius: 6px;
  background: var(--dsw-alias-bg-layer-2);
  font-size: 11px;
  line-height: 16px;
  font-weight: 500;
  white-space: nowrap;
}
.envx-flow-arrow {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  min-width: 18px;
  position: relative;
}
.envx-flow-arrow::before {
  content: '';
  position: absolute;
  left: 0;
  right: 8px;
  top: 50%;
  border-top: 1.5px dashed currentColor;
  opacity: 0.55;
}
.envx-flow-arrow svg {
  margin-left: auto;
  position: relative;
}
.envx-flow[data-dir='reverse'] .envx-flow-arrow {
  transform: scaleX(-1);
}
.envx-mode[data-on] .envx-flow {
  color: var(--dsw-alias-state-business-primary);
}
.envx-mode[data-on] .envx-flow-node {
  background: color-mix(in srgb, var(--dsw-alias-state-business-primary) 12%, transparent);
}
.envx-mode[data-on] .envx-flow-arrow::before {
  animation: envx-flow 0.9s linear infinite;
  opacity: 0.8;
  border-top-style: solid;
  background: none;
}
@keyframes envx-flow {
  from {
    opacity: 0.45;
  }
  50% {
    opacity: 0.95;
  }
  to {
    opacity: 0.45;
  }
}
@media (prefers-reduced-motion: reduce) {
  .envx-mode[data-on] .envx-flow-arrow::before {
    animation: none;
  }
}
.envx-chip code {
  font-family: var(--dsw-font-mono, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace);
  font-size: 11.5px;
}
.envx-card-notice {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 6px 6px 10px;
  border-radius: 8px;
  font-size: 12px;
  line-height: 17px;
  color: var(--envx-warn);
  background: color-mix(in srgb, var(--envx-warn) 9%, transparent);
}
.envx-card-notice span {
  flex: 1;
  min-width: 0;
}
.envx-card-notice .envx-textbtn {
  flex: none;
}
.envx-error-line {
  color: var(--dsw-alias-state-error-primary);
  font-size: 12px;
  line-height: 18px;
  overflow-wrap: anywhere;
}
.envx-card-foot {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  margin-top: auto;
  padding-top: 4px;
}
/* The trailing icon actions wrap as one unit and stick to the right edge, so a narrow card
   never strands a single icon (the delete button) on a line of its own. */
.envx-card-tools {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  flex: none;
  margin-left: auto;
}
.envx-iconbtn {
  appearance: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  border: none;
  border-radius: 8px;
  background: transparent;
  color: var(--dsw-alias-label-tertiary);
  cursor: pointer;
  transition:
    background 0.12s,
    color 0.12s;
}
.envx-iconbtn:hover {
  background: var(--dsw-alias-interactive-bg-hover);
  color: var(--dsw-alias-label-primary);
}
.envx-iconbtn[data-danger]:hover {
  background: var(--dsw-alias-interactive-bg-hover-danger, var(--dsw-alias-interactive-bg-hover));
  color: var(--dsw-alias-state-error-primary);
}
.envx-iconbtn:disabled {
  opacity: 0.4;
  cursor: default;
}
.envx-linkbtn {
  appearance: none;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 28px;
  padding: 0 10px;
  border: 0.5px solid var(--dsw-alias-border-l2);
  border-radius: 8px;
  background: transparent;
  color: var(--dsw-alias-label-primary);
  font: inherit;
  font-size: 12.5px;
  cursor: pointer;
  white-space: nowrap;
  transition:
    background 0.12s,
    border-color 0.12s;
}
.envx-linkbtn:hover {
  background: var(--dsw-alias-interactive-bg-hover);
  border-color: var(--dsw-alias-border-l3);
}
.envx-linkbtn:disabled {
  opacity: 0.5;
  cursor: default;
}
.envx-linkbtn[data-primary] {
  border-color: transparent;
  color: var(--dsw-alias-label-primary-foreground, #fff);
  background: var(--dsw-alias-button-primary-fill, var(--dsw-alias-brand-primary));
}
.envx-linkbtn[data-primary]:hover {
  background: var(--dsw-alias-button-primary-hover, var(--dsw-alias-brand-primary));
}

.envx-list {
  border: 0.5px solid var(--dsw-alias-border-l2);
  border-radius: 14px;
  background: var(--dsw-alias-bg-layer-1);
  overflow: hidden;
}
.envx-row {
  display: flex;
  align-items: center;
  gap: 12px;
  min-height: 56px;
  padding: 10px 14px 10px 16px;
}
.envx-row + .envx-row {
  border-top: 0.5px solid var(--dsw-alias-border-l1);
}
.envx-row-main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
}
.envx-row-main strong {
  font-size: 13.5px;
  line-height: 20px;
  font-weight: 500;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.envx-row-main span {
  color: var(--dsw-alias-label-tertiary);
  font-size: 12px;
  line-height: 18px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.envx-row .envx-tile {
  width: 32px;
  height: 32px;
  border-radius: 9px;
}
.envx-empty {
  padding: 22px 16px;
  color: var(--dsw-alias-label-tertiary);
  font-size: 13px;
  text-align: center;
  border: 0.5px dashed var(--dsw-alias-border-l2);
  border-radius: 14px;
}
.envx-banner {
  display: flex;
  gap: 8px;
  align-items: flex-start;
  margin-bottom: 16px;
  padding: 10px 12px;
  border-radius: 10px;
  font-size: 13px;
  line-height: 20px;
  color: var(--dsw-alias-state-error-primary);
  background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 8%, transparent);
  overflow-wrap: anywhere;
}
.envx-banner[data-tone='info'] {
  color: var(--dsw-alias-label-secondary);
  background: var(--dsw-alias-bg-layer-2);
}
.envx-spin {
  animation: envx-spin 0.9s linear infinite;
}
@keyframes envx-spin {
  to {
    transform: rotate(360deg);
  }
}

/* dialogs */
.envx-dialog {
  width: min(560px, calc(100vw - 48px));
}
.envx-dialog-wide {
  width: min(720px, calc(100vw - 48px));
}
/* live desktop viewer: a wide dialog holding the newest frame */
.envx-desktop {
  width: min(1180px, calc(100vw - 48px));
}
.envx-desktop-frame {
  min-height: 240px;
  max-height: min(72vh, 900px);
  overflow: auto;
  background: #000;
  border-radius: 6px;
  display: flex;
  align-items: center;
  justify-content: center;
}
.envx-form {
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.envx-field {
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-width: 0;
}
.envx-field > label {
  font-size: 12.5px;
  line-height: 18px;
  color: var(--dsw-alias-label-secondary);
  font-weight: 500;
}
.envx-field small {
  color: var(--dsw-alias-label-tertiary);
  font-size: 12px;
  line-height: 17px;
}
.envx-field-row {
  display: grid;
  grid-template-columns: 1fr 120px;
  gap: 12px;
}
.envx-field-row[data-even] {
  grid-template-columns: 1fr 1fr;
}
.envx-input {
  box-sizing: border-box;
  width: 100%;
  height: 34px;
  padding: 0 10px;
  border-radius: 8px;
  border: 0.5px solid var(--dsw-alias-border-l3);
  background: var(--dsw-alias-bg-base);
  color: var(--dsw-alias-label-primary);
  font: inherit;
  font-size: 13.5px;
  outline: none;
  transition:
    border-color 0.12s,
    box-shadow 0.12s;
}
.envx-input:focus {
  border-color: var(--dsw-alias-state-business-primary);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--dsw-alias-state-business-primary) 16%, transparent);
}
.envx-input::placeholder {
  color: var(--dsw-alias-label-dimmed, var(--dsw-alias-label-tertiary));
}
.envx-input[data-mono] {
  font-family: var(--dsw-font-mono, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace);
  font-size: 12.5px;
}
select.envx-input {
  appearance: none;
  padding-right: 28px;
  background-image:
    linear-gradient(45deg, transparent 50%, currentColor 50%),
    linear-gradient(135deg, currentColor 50%, transparent 50%);
  background-position:
    calc(100% - 15px) 14px,
    calc(100% - 10px) 14px;
  background-size: 5px 5px;
  background-repeat: no-repeat;
}
.envx-switch-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 10px 12px;
  border-radius: 10px;
  background: var(--dsw-alias-bg-layer-2);
}
.envx-switch-row div {
  display: flex;
  flex-direction: column;
  min-width: 0;
}
.envx-switch-row span {
  font-size: 13px;
  line-height: 20px;
}
.envx-switch-row small {
  color: var(--dsw-alias-label-tertiary);
  font-size: 12px;
  line-height: 17px;
}
.envx-kinds {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 10px;
}
.envx-kind {
  appearance: none;
  display: flex;
  gap: 12px;
  align-items: flex-start;
  text-align: left;
  padding: 14px;
  border-radius: 12px;
  border: 0.5px solid var(--dsw-alias-border-l2);
  background: var(--dsw-alias-bg-layer-1);
  color: inherit;
  font: inherit;
  cursor: pointer;
  transition:
    border-color 0.12s,
    background 0.12s,
    transform 0.12s;
}
.envx-kind:hover {
  border-color: var(--envx-accent);
  background: color-mix(in srgb, var(--envx-accent) 5%, var(--dsw-alias-bg-layer-1));
}
.envx-kind:active {
  transform: scale(0.99);
}
.envx-kind strong {
  display: block;
  font-size: 13.5px;
  line-height: 20px;
  font-weight: 600;
}
.envx-kind span span {
  display: block;
  color: var(--dsw-alias-label-tertiary);
  font-size: 12px;
  line-height: 17px;
}
.envx-help {
  padding: 12px;
  border-radius: 10px;
  background: var(--dsw-alias-bg-layer-2);
  font-size: 12.5px;
  line-height: 19px;
  color: var(--dsw-alias-label-secondary);
}
.envx-help strong {
  display: block;
  color: var(--dsw-alias-label-primary);
  font-weight: 600;
  margin-bottom: 2px;
}
.envx-help code {
  display: block;
  margin-top: 8px;
  padding: 8px 10px;
  border-radius: 8px;
  background: var(--dsw-alias-markdown-code-block, var(--dsw-alias-bg-base));
  color: var(--dsw-alias-label-primary);
  font-family: var(--dsw-font-mono, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace);
  font-size: 12px;
  overflow-x: auto;
  white-space: nowrap;
  user-select: all;
}
.envx-result {
  display: flex;
  gap: 8px;
  align-items: flex-start;
  padding: 10px 12px;
  border-radius: 10px;
  font-size: 12.5px;
  line-height: 19px;
  overflow-wrap: anywhere;
}
.envx-result[data-ok='true'] {
  color: var(--dsw-alias-state-success-primary);
  background: color-mix(in srgb, var(--dsw-alias-state-success-primary) 10%, transparent);
}
.envx-result[data-ok='false'] {
  color: var(--dsw-alias-state-error-primary);
  background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 8%, transparent);
}
.envx-footer {
  width: 100%;
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  align-items: center;
}
.envx-footer .envx-spacer {
  flex: 1;
}
.envx-result[data-ok='pending'] {
  color: var(--dsw-alias-label-secondary);
  background: var(--dsw-alias-bg-layer-2);
}
.envx-form-note {
  margin-top: -8px;
  color: var(--dsw-alias-label-tertiary);
  font-size: 12px;
  line-height: 17px;
}
.envx-field-row[data-three] {
  grid-template-columns: 1fr 96px 1fr;
}
.envx-field-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  min-height: 28px;
}
.envx-field-head > label {
  font-size: 12.5px;
  line-height: 18px;
  color: var(--dsw-alias-label-secondary);
  font-weight: 500;
}
.envx-seg {
  align-self: flex-start;
}
.envx-field-head .envx-seg {
  align-self: center;
}

/* collapsible group */
.envx-disc {
  border-radius: 10px;
  border: 0.5px solid var(--dsw-alias-border-l2);
  background: var(--dsw-alias-bg-layer-1);
}
.envx-disc-head {
  appearance: none;
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  min-height: 40px;
  padding: 8px 12px;
  border: none;
  border-radius: 10px;
  background: transparent;
  color: var(--dsw-alias-label-primary);
  font: inherit;
  font-size: 13px;
  text-align: left;
  cursor: pointer;
}
.envx-disc-head:hover {
  background: var(--dsw-alias-interactive-bg-hover);
}
.envx-disc-head:focus-visible {
  outline: none;
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--dsw-alias-state-business-primary) 22%, transparent);
}
.envx-disc-head > svg {
  flex: none;
  color: var(--dsw-alias-label-tertiary);
  transition: transform 0.15s;
}
.envx-disc-head[aria-expanded='true'] > svg {
  transform: rotate(90deg);
}
.envx-disc[data-open] .envx-disc-head {
  border-bottom-left-radius: 0;
  border-bottom-right-radius: 0;
}
.envx-disc-title {
  flex: none;
  font-weight: 500;
}
.envx-disc-summary {
  flex: 1;
  min-width: 0;
  color: var(--dsw-alias-label-tertiary);
  font-size: 12px;
  line-height: 17px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  text-align: right;
}
.envx-disc-summary svg {
  vertical-align: middle;
}
.envx-disc-summary [data-tone='warn'] {
  color: var(--envx-warn);
}
.envx-disc-summary [data-tone='error'] {
  color: var(--dsw-alias-state-error-primary);
}
.envx-disc-body {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 4px 12px 14px;
}
.envx-disc-text {
  margin: 0;
  color: var(--dsw-alias-label-secondary);
  font-size: 12.5px;
  line-height: 19px;
}
.envx-disc-body .envx-switch-row {
  background: var(--dsw-alias-bg-layer-2);
}
.envx-inline-actions {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  color: var(--dsw-alias-label-tertiary);
  font-size: 12px;
  line-height: 17px;
}

/* copyable command */
.envx-cmd {
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-width: 0;
}
.envx-cmd-label {
  font-size: 12px;
  line-height: 17px;
  color: var(--dsw-alias-label-secondary);
  font-weight: 500;
}
.envx-cmd-body {
  position: relative;
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 9px 10px 9px 12px;
  border-radius: 8px;
  border: 0.5px solid var(--dsw-alias-border-l2);
  background: var(--dsw-alias-markdown-code-block, var(--dsw-alias-bg-base));
}
.envx-cmd-body code {
  flex: 1;
  min-width: 0;
  padding-top: 3px;
  color: var(--dsw-alias-label-primary);
  font-family: var(--dsw-font-mono, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace);
  font-size: 12px;
  line-height: 18px;
  white-space: pre-wrap;
  word-break: break-all;
  user-select: all;
}
.envx-cmd-copy {
  appearance: none;
  flex: none;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: 24px;
  padding: 0 8px;
  border: 0.5px solid var(--dsw-alias-border-l3);
  border-radius: 6px;
  background: var(--dsw-alias-bg-layer-1);
  color: var(--dsw-alias-label-secondary);
  font: inherit;
  font-size: 12px;
  cursor: pointer;
  transition:
    color 0.12s,
    background 0.12s,
    border-color 0.12s;
}
.envx-cmd-copy:hover {
  color: var(--dsw-alias-label-primary);
  background: var(--dsw-alias-interactive-bg-hover);
}
.envx-cmd-copy[data-copied] {
  color: var(--dsw-alias-state-success-primary);
  border-color: color-mix(in srgb, var(--dsw-alias-state-success-primary) 40%, transparent);
}

/* a guided step: icon, title, text, optional action */
.envx-step {
  display: flex;
  align-items: flex-start;
  gap: 12px;
  padding: 12px;
  border-radius: 10px;
  background: color-mix(in srgb, var(--envx-accent, var(--dsw-alias-state-business-primary)) 7%, transparent);
}
.envx-step > div {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.envx-step strong {
  font-size: 13px;
  line-height: 19px;
  font-weight: 600;
}
.envx-step > div > span {
  color: var(--dsw-alias-label-secondary);
  font-size: 12.5px;
  line-height: 19px;
}
.envx-step > button {
  flex: none;
  align-self: center;
}
.envx-step-icon {
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 30px;
  height: 30px;
  border-radius: 8px;
  color: var(--envx-accent, var(--dsw-alias-state-business-primary));
  background: color-mix(in srgb, var(--envx-accent, var(--dsw-alias-state-business-primary)) 14%, transparent);
}

/* live connection state of a reverse environment */
.envx-live {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 12px;
  border-radius: 10px;
  font-size: 12.5px;
  line-height: 18px;
  color: var(--dsw-alias-label-secondary);
  background: var(--dsw-alias-bg-layer-2);
  overflow-wrap: anywhere;
}
.envx-live i {
  flex: none;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--dsw-alias-state-success-primary);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--dsw-alias-state-success-primary) 22%, transparent);
}
.envx-live[data-state='ok'] {
  color: var(--dsw-alias-state-success-primary);
  background: color-mix(in srgb, var(--dsw-alias-state-success-primary) 10%, transparent);
}

/* remote browser */
.envx-browser {
  display: flex;
  flex-direction: column;
  gap: 12px;
  min-height: 0;
}
.envx-browser-bar {
  display: flex;
  gap: 8px;
  align-items: center;
}
.envx-browser-bar select {
  flex: none;
  width: 200px;
}
.envx-browser-busy {
  display: inline-flex;
  align-items: center;
  flex: none;
  color: var(--dsw-alias-label-tertiary);
}
.envx-browser-frame {
  position: relative;
  min-height: 0;
}
.envx-browser-list {
  height: 320px;
  overflow: auto;
  border: 0.5px solid var(--dsw-alias-border-l2);
  border-radius: 10px;
  background: var(--dsw-alias-bg-base);
}
.envx-browser-overlay {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  border-radius: 10px;
  color: var(--dsw-alias-label-tertiary);
  font-size: 13px;
  background: color-mix(in srgb, var(--dsw-alias-bg-base) 72%, transparent);
  backdrop-filter: blur(1px);
}
.envx-entry {
  appearance: none;
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  height: 34px;
  padding: 0 12px;
  border: none;
  background: transparent;
  color: var(--dsw-alias-label-primary);
  font: inherit;
  font-size: 13px;
  text-align: left;
  cursor: pointer;
}
.envx-entry:hover {
  background: var(--dsw-alias-interactive-bg-hover);
}
.envx-entry:disabled {
  cursor: default;
  opacity: 0.55;
}
.envx-entry:disabled:hover {
  background: transparent;
}
.envx-entry[data-type='file'] {
  color: var(--dsw-alias-label-tertiary);
  cursor: default;
}
.envx-entry[data-type='file']:hover {
  background: transparent;
}
.envx-entry svg {
  flex: none;
  color: var(--dsw-alias-label-tertiary);
}
.envx-entry[data-type='dir'] svg {
  color: #e0a43a;
}
.envx-entry span {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.envx-entry em {
  flex: none;
  font-style: normal;
  color: var(--dsw-alias-label-tertiary);
  font-size: 12px;
  font-variant-numeric: tabular-nums;
}
.envx-browser-state {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  height: 100%;
  color: var(--dsw-alias-label-tertiary);
  font-size: 13px;
  padding: 0 24px;
  text-align: center;
}
.envx-crumbs {
  display: flex;
  align-items: center;
  gap: 2px;
  min-width: 0;
  flex: 1;
  height: 34px;
  padding: 0 6px;
  border-radius: 8px;
  border: 0.5px solid var(--dsw-alias-border-l3);
  background: var(--dsw-alias-bg-base);
  overflow: hidden;
}
.envx-crumbs input {
  flex: 1;
  min-width: 0;
  height: 100%;
  border: none;
  outline: none;
  background: transparent;
  color: var(--dsw-alias-label-primary);
  font-family: var(--dsw-font-mono, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace);
  font-size: 12.5px;
}

/* composer chip + popover */
.envx-chipbtn {
  appearance: none;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 28px;
  padding: 0 8px;
  border: none;
  border-radius: 8px;
  background: transparent;
  color: var(--dsw-alias-label-secondary);
  font: inherit;
  font-size: 13px;
  line-height: 20px;
  cursor: pointer;
  white-space: nowrap;
  max-width: 220px;
  transition:
    background 0.12s,
    color 0.12s;
}
.envx-chipbtn:hover,
.envx-chipbtn[aria-expanded='true'] {
  background: var(--dsw-alias-interactive-bg-hover);
  color: var(--dsw-alias-label-primary);
}
.envx-chipbtn[data-active] {
  color: var(--dsw-alias-state-business-primary);
}
.envx-chipbtn[data-error] {
  color: var(--dsw-alias-state-error-primary);
}
.envx-chipbtn i {
  flex: none;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--dsw-alias-state-error-primary);
}
.envx-chipbtn span {
  overflow: hidden;
  text-overflow: ellipsis;
}
.envx-chipbtn b {
  font-weight: 500;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 16px;
  height: 16px;
  padding: 0 4px;
  border-radius: 8px;
  font-size: 11px;
  line-height: 16px;
  color: var(--dsw-alias-label-primary-foreground, #fff);
  background: var(--dsw-alias-state-business-primary);
}
/* GUI lease badge next to the environment name */
.envx-chipbtn em {
  font-style: normal;
  font-size: 10.5px;
  line-height: 14px;
  padding: 0 4px;
  border-radius: 4px;
  border: 1px solid currentColor;
  opacity: 0.8;
}
.envx-pop {
  position: fixed;
  z-index: 1000;
  width: 340px;
  max-height: min(560px, calc(100vh - 32px));
  overflow: auto;
  padding: 6px;
  border-radius: 14px;
  border: 0.5px solid var(--dsw-alias-border-l2);
  background: color-mix(in srgb, var(--dsw-alias-bg-layer-1) 92%, transparent);
  backdrop-filter: blur(24px);
  box-shadow: 0 12px 40px color-mix(in srgb, #000 18%, transparent);
  color: var(--dsw-alias-label-primary);
  font-size: 13px;
  line-height: 20px;
  animation: envx-pop 0.12s ease-out;
}
@keyframes envx-pop {
  from {
    opacity: 0;
    transform: translateY(4px);
  }
}
.envx-pop-section {
  padding: 10px 10px 8px;
}
.envx-pop-section + .envx-pop-section {
  border-top: 0.5px solid var(--dsw-alias-border-l1);
}
.envx-pop-title {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  font-size: 12px;
  line-height: 18px;
  font-weight: 600;
  color: var(--dsw-alias-label-secondary);
  text-transform: none;
  margin-bottom: 6px;
}
.envx-pop-title small {
  font-weight: 400;
  color: var(--dsw-alias-label-tertiary);
}
.envx-pop-hint {
  color: var(--dsw-alias-label-tertiary);
  font-size: 12px;
  line-height: 17px;
  margin: 0 0 8px;
}
.envx-pop-item {
  display: flex;
  align-items: center;
  gap: 10px;
  min-height: 36px;
  padding: 4px 6px;
  border-radius: 8px;
}
.envx-pop-item[data-click] {
  cursor: pointer;
}
.envx-pop-item[data-click]:hover {
  background: var(--dsw-alias-interactive-bg-hover);
}
.envx-pop-item .envx-tile {
  width: 26px;
  height: 26px;
  border-radius: 7px;
}
.envx-pop-item-main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
}
.envx-pop-item-main strong {
  font-weight: 500;
  font-size: 13px;
  line-height: 18px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.envx-pop-item-main span {
  color: var(--dsw-alias-label-tertiary);
  font-size: 11.5px;
  line-height: 16px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.envx-check {
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 16px;
  height: 16px;
  border-radius: 5px;
  border: 1px solid var(--dsw-alias-border-l4, var(--dsw-alias-border-l3));
  color: transparent;
  transition:
    background 0.1s,
    border-color 0.1s;
}
.envx-check[data-on] {
  background: var(--dsw-alias-state-business-primary);
  border-color: var(--dsw-alias-state-business-primary);
  color: #fff;
}
.envx-pop-foot {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 8px;
}
.envx-textbtn {
  appearance: none;
  border: none;
  background: transparent;
  padding: 2px 6px;
  border-radius: 6px;
  color: var(--dsw-alias-state-business-primary);
  font: inherit;
  font-size: 12px;
  cursor: pointer;
}
.envx-textbtn:hover {
  background: color-mix(in srgb, var(--dsw-alias-state-business-primary) 10%, transparent);
}
.envx-textbtn[data-quiet] {
  color: var(--dsw-alias-label-tertiary);
}
.envx-textbtn[data-quiet]:hover {
  background: var(--dsw-alias-interactive-bg-hover);
  color: var(--dsw-alias-label-primary);
}
.envx-textbtn:disabled {
  opacity: 0.5;
  cursor: default;
}
.envx-mounted {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px;
  border-radius: 10px;
  background: color-mix(in srgb, var(--dsw-alias-state-business-primary) 8%, transparent);
}
.envx-hero {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  padding: 40px 16px;
  border: 0.5px dashed var(--dsw-alias-border-l2);
  border-radius: 14px;
  text-align: center;
}
.envx-hero strong {
  font-size: 14px;
  font-weight: 600;
}
.envx-hero span {
  color: var(--dsw-alias-label-tertiary);
  font-size: 13px;
}

/* ---- workspace bindings (sidebar rows of remote workspaces) ---- */
.envx-ws-tag {
  display: inline-flex;
  flex: 0 1 auto;
  align-items: center;
  gap: 4px;
  min-width: 0;
  max-width: 112px;
  height: 20px;
  padding: 0 6px;
  border: none;
  border-radius: var(--dsw-radius-sm, 6px);
  background: transparent;
  color: var(--dsw-alias-label-tertiary);
  font: inherit;
  font-size: 11px;
  line-height: 16px;
}
.envx-ws-tag svg {
  flex: none;
}
.envx-ws-tag-name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.envx-ws-tag[data-state='offline'],
.envx-ws-tag[data-state='error'] {
  color: var(--dsw-alias-state-error-primary);
}
.envx-ws-dot {
  flex: none;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--dsw-alias-state-error-primary);
}
.envx-ws-dot[data-state='busy'] {
  background: var(--dsw-alias-state-warn-primary);
}
`;var pe=ie(require("react"),1),J=require("react"),qn=require("react-dom");var Ls='[role="treeitem"][data-row-key^="workspace:"]',_n="data-envx-ws",Bs=[],$s=e=>e({items:Bs}),Hs=e=>e.items;function Fs(){let e=document.createElement("span");return e.setAttribute(_n,"trail"),e.style.display="contents",e}function Ks(e,n){let t=Array.from(e.children).find(r=>!r.hasAttribute(_n)&&r.querySelector("button"));(n.parentElement!==e||n.nextElementSibling!==(t??null))&&e.insertBefore(n,t??null)}function Os(e,n){return e.length===n.length&&e.every((t,r)=>{let i=n[r];return!!i&&t.workspaceId===i.workspaceId&&t.row===i.row&&t.trail===i.trail})}function js(e,n){if(!n)return"";let t=e(`ws.state.${n.state}`);return n.reason?`${t} \xB7 ${n.reason}`:t}function Us({binding:e,view:n,t}){let r=n?.environments.find(a=>a.id===e.envId),i=e.envId?n?.availability[e.envId]:void 0,p=r?.name??e.envId??"",o=mn(i?.state),d=[t("ws.tag.remote",{name:p,root:e.remoteRoot??""}),js(t,i)].filter(Boolean).join(`
`);return pe.createElement("span",{className:"envx-ws-tag","data-state":i?.state??"unknown",title:d,"aria-label":d,role:"img"},pe.createElement(Z,{kind:r?.kind,size:12}),pe.createElement("span",{className:"envx-ws-tag-name"},p),(o||i?.state==="busy")&&pe.createElement("span",{className:"envx-ws-dot","data-state":i?.state,"aria-hidden":"true"}))}function Gn({store:e,t:n,useWorkspaces:t}){let i=(t??$s)(Hs),p=(0,J.useSyncExternalStore)(e.subscribe,e.getSnapshot),[o,d]=(0,J.useState)([]),[a,u]=(0,J.useState)([]),y=(0,J.useRef)(new Map),m=(0,J.useRef)(p.byId);m.current=p.byId,(0,J.useEffect)(()=>{let c=i.length>0?i.map(f=>({workspaceId:f.workspaceId,path:f.path})):a.map(f=>({workspaceId:f}));e.setWorkspaces(c)},[i,a,e]);let I=(0,J.useCallback)(()=>{let c=m.current,f=new Set,C=[],R=[];for(let k of document.querySelectorAll(Ls)){let w=vn(k.getAttribute("data-row-key"));if(!w)continue;C.push(w);let h=c.get(w);if(!h?.envId||h.kind!=="remote")continue;f.add(k);let z=y.current.get(k);z||(z=Fs(),y.current.set(k,z)),Ks(k,z),R.push({workspaceId:w,row:k,trail:z})}for(let[k,w]of y.current)f.has(k)||(w.remove(),y.current.delete(k));d(k=>Os(k,R)?k:R),u(k=>k.length===C.length&&k.every((w,h)=>w===C[h])?k:C)},[]);return(0,J.useLayoutEffect)(()=>{I()},[p.byId,I]),(0,J.useEffect)(()=>{if(typeof document>"u"||typeof MutationObserver>"u")return;let c=0,f=()=>{c||(c=requestAnimationFrame(()=>{c=0,I()}))},C=new MutationObserver(k=>{for(let w of k){let h=w.target instanceof Element?w.target:null;if(h===document.body||h?.closest('[role="tree"]')){f();return}}});C.observe(document.body,{childList:!0,subtree:!0});let R=y.current;return()=>{C.disconnect(),cancelAnimationFrame(c);for(let k of R.values())k.remove();R.clear()}},[I]),pe.createElement(pe.Fragment,null,o.map(c=>{let f=p.byId.get(c.workspaceId);return f?(0,qn.createPortal)(pe.createElement(Us,{binding:f,view:p.view,t:n}),c.trail,c.workspaceId):null}))}var an="environments",qs=["slots","locale","layout","uiWorkspace"];function _s(e){e.effect(()=>e.locale.register(xe,Dn),"environments: dictionaries");let n=e.locale.bind(xe),t=m=>e.locale.subscribe(m),r=()=>e.locale.getSnapshot();e.effect(()=>{if(typeof document>"u")return()=>{};let m=document.createElement("style");return m.dataset.plugin="dsh-plugin-environments",m.textContent=Un,document.head.appendChild(m),()=>m.remove()},"environments: styles");let i=()=>{try{e.layout.selectPanel(an)}catch{}},p=m=>{try{e.uiWorkspace.startSession(m)}catch{}};function o(){return(0,Ge.useSyncExternalStore)(t,r),Pe.createElement(jn,{t:n,startSession:p})}function d({sessionId:m}){return(0,Ge.useSyncExternalStore)(t,r),m?Pe.createElement(Mn,{sessionId:m,t:n,openManager:i}):null}let a=new Be;function u({useWorkspaces:m}){return(0,Ge.useSyncExternalStore)(t,r),Pe.createElement(Gn,{store:a,t:n,useWorkspaces:m})}function y({size:m}){return Pe.createElement(wn,{size:m})}e.slots.inject("main",()=>e.slots.register({name:"main",key:an,locale:xe},o)),e.slots.inject("sidebar.panellist",()=>e.slots.register({name:"sidebar.panellist",id:an,order:30,locale:xe,label:()=>n("panel")},y)),e.slots.inject("conversation.input.left",()=>e.slots.register({name:"conversation.input.left",id:"environments",order:60,locale:xe,inject:m=>({sessionId:m===void 0?void 0:String(m)})},d)),e.slots.inject("shell.overlay",()=>e.slots.register({name:"shell.overlay",id:"environments.workspace-bindings",locale:xe},u))}

		})(module, module.exports, require);
		const entry = module.exports;
		return { inject: entry.inject, apply: entry.apply };
	},
});
