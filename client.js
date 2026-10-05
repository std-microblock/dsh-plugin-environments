window.__ModuleLoader__.load({
	id: "dsh-plugin-environments",
	factory(require) {
		const module = { exports: {} };
		(function (module, exports, require) {
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target2, all) => {
  for (var name in all)
    __defProp(target2, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target2) => (target2 = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target2, "default", { value: mod, enumerable: true }) : target2,
  mod
));
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/client/index.jsx
var index_exports = {};
__export(index_exports, {
  apply: () => apply,
  inject: () => inject
});
module.exports = __toCommonJS(index_exports);
var React6 = __toESM(require("react"), 1);
var import_react6 = require("react");

// src/client/locales.js
var NS = "environments";
var zh = {
  "panel": "\u73AF\u5883",
  "page.title": "\u73AF\u5883",
  "page.subtitle": "\u8BA9\u667A\u80FD\u4F53\u4F7F\u7528\u5176\u4ED6\u8BBE\u5907\uFF1A\u6302\u8F7D\u4E3A\u5DE5\u4F5C\u533A\uFF0C\u6216\u5728\u9700\u8981\u65F6\u501F\u7528\u3002",
  "action.refresh": "\u5237\u65B0",
  "action.add": "\u6DFB\u52A0\u73AF\u5883",
  "action.test": "\u6D4B\u8BD5\u8FDE\u63A5",
  "action.testing": "\u8FDE\u63A5\u4E2D\u2026",
  "action.edit": "\u7F16\u8F91",
  "action.delete": "\u5220\u9664",
  "action.cancel": "\u53D6\u6D88",
  "action.save": "\u4FDD\u5B58",
  "action.saveAndTest": "\u4FDD\u5B58\u5E76\u6D4B\u8BD5",
  "action.close": "\u5173\u95ED",
  "action.newWorkspace": "\u65B0\u5EFA\u8FDC\u7A0B\u5DE5\u4F5C\u533A",
  "action.browse": "\u6D4F\u89C8\u6587\u4EF6",
  "action.release": "\u91CA\u653E",
  "action.return": "\u5F52\u8FD8",
  "action.newSession": "\u65B0\u4F1A\u8BDD",
  "action.remove": "\u79FB\u9664",
  "action.addDevice": "\u6DFB\u52A0\u5230\u5217\u8868",
  "action.create": "\u521B\u5EFA",
  "action.manage": "\u7BA1\u7406\u73AF\u5883\u2026",
  "action.apply": "\u5E94\u7528",
  "action.unmount": "\u53D6\u6D88\u6302\u8F7D",
  "action.choose": "\u9009\u62E9\u6B64\u76EE\u5F55",
  "action.up": "\u4E0A\u4E00\u7EA7",
  "action.home": "\u4E3B\u76EE\u5F55",
  "action.newFolder": "\u65B0\u5EFA\u6587\u4EF6\u5939",
  "action.open": "\u6253\u5F00",
  "action.retry": "\u91CD\u8BD5",
  "kind.local": "\u672C\u673A",
  "kind.server": "\u73AF\u5883\u670D\u52A1\u5668",
  "kind.ssh": "SSH",
  "kind.adb": "Android (ADB)",
  "kind.winuser": "Windows \u8D26\u6237",
  "kind.local.desc": "\u8FD0\u884C dsh \u7684\u8FD9\u53F0\u7535\u8111",
  "kind.server.desc": "\u8FDE\u63A5\u5230\u8FD0\u884C dsh-env-server \u7684\u673A\u5668",
  "kind.ssh.desc": "\u901A\u8FC7 SSH \u8FDE\u63A5\u670D\u52A1\u5668",
  "kind.adb.desc": "\u771F\u673A\u6216\u6A21\u62DF\u5668\uFF0C\u901A\u8FC7 adb \u63A7\u5236",
  "kind.winuser.desc": "\u672C\u673A\u4E0A\u7684\u53D7\u9650\u6D4B\u8BD5\u8D26\u6237\uFF0C\u53EF\u8FD0\u884C\u56FE\u5F62\u754C\u9762\u7A0B\u5E8F",
  "section.environments": "\u73AF\u5883",
  "section.workspaces": "\u8FDC\u7A0B\u5DE5\u4F5C\u533A",
  "section.workspaces.hint": "\u8FDC\u7A0B\u5DE5\u4F5C\u533A\u91CC\u7684\u4F1A\u8BDD\u4F1A\u76F4\u63A5\u5728\u8BE5\u73AF\u5883\u4E2D\u8BFB\u5199\u6587\u4EF6\u3001\u6267\u884C\u547D\u4EE4\u3002",
  "section.workspaces.empty": "\u8FD8\u6CA1\u6709\u8FDC\u7A0B\u5DE5\u4F5C\u533A\u3002\u5728\u4EFB\u610F\u73AF\u5883\u5361\u7247\u4E0A\u9009\u62E9\u201C\u65B0\u5EFA\u8FDC\u7A0B\u5DE5\u4F5C\u533A\u201D\u3002",
  "section.leases": "\u4F7F\u7528\u4E2D",
  "section.leases.empty": "\u5F53\u524D\u6CA1\u6709\u4F1A\u8BDD\u5728\u4F7F\u7528\u73AF\u5883\u3002",
  "section.accounts": "Windows \u6D4B\u8BD5\u8D26\u6237",
  "section.accounts.hint": "\u53D7\u9650\u7684\u672C\u5730\u6807\u51C6\u8D26\u6237\u3002\u4EE5\u5B83\u8FD0\u884C\u7684\u7A0B\u5E8F\u663E\u793A\u5728\u5F53\u524D\u684C\u9762\u4E0A\uFF0C\u4FBF\u4E8E\u667A\u80FD\u4F53\u8FDB\u884C\u754C\u9762\u6D4B\u8BD5\u3002\u521B\u5EFA\u548C\u5220\u9664\u9700\u8981\u7BA1\u7406\u5458\u786E\u8BA4\u3002",
  "section.accounts.empty": "\u8FD8\u6CA1\u6709\u6D4B\u8BD5\u8D26\u6237\u3002",
  "status.available": "\u7A7A\u95F2",
  "status.busy": "\u4F7F\u7528\u4E2D",
  "status.busyBy": "{who} \u4F7F\u7528\u4E2D",
  "status.queue": "{count} \u4E2A\u4F1A\u8BDD\u6392\u961F",
  "status.offline": "\u79BB\u7EBF",
  "status.unknown": "\u672A\u68C0\u6D4B",
  "status.connected": "\u53EF\u8FDE\u63A5 \xB7 {ms} ms",
  "status.failed": "\u8FDE\u63A5\u5931\u8D25",
  "status.discovered": "\u81EA\u52A8\u53D1\u73B0",
  "status.builtin": "\u5185\u7F6E",
  "status.shared": "\u53EF\u540C\u65F6\u4F7F\u7528",
  "status.exclusive": "\u72EC\u5360",
  "badge.mount": "\u6302\u8F7D",
  "badge.borrow": "\u501F\u7528",
  "field.name": "\u540D\u79F0",
  "field.name.ph": "\u4F8B\u5982\uFF1A\u6D4B\u8BD5\u673A Pixel 8",
  "field.id": "\u6807\u8BC6",
  "field.id.hint": "\u667A\u80FD\u4F53\u501F\u7528\u540E\uFF0C\u5DE5\u5177\u540D\u4EE5\u5B83\u4E3A\u524D\u7F00\uFF0C\u4F8B\u5982 {alias}__screenshot",
  "field.description": "\u5907\u6CE8",
  "field.host": "\u4E3B\u673A",
  "field.port": "\u7AEF\u53E3",
  "field.token": "\u4EE4\u724C",
  "field.token.hint": "\u542F\u52A8 dsh-env-server \u65F6\u6253\u5370\u6216\u901A\u8FC7 --token \u6307\u5B9A",
  "field.username": "\u7528\u6237\u540D",
  "field.password": "\u5BC6\u7801",
  "field.password.hint": "\u7559\u7A7A\u5219\u4F7F\u7528\u5BC6\u94A5\u6216 ssh-agent",
  "field.privateKey": "\u79C1\u94A5\u8DEF\u5F84",
  "field.privateKey.ph": "~/.ssh/id_ed25519",
  "field.passphrase": "\u79C1\u94A5\u53E3\u4EE4",
  "field.serverPath": "\u8FDC\u7AEF dsh-env-server \u8DEF\u5F84",
  "field.serverPath.hint": "\u53EF\u9009\u3002\u586B\u5199\u540E\u901A\u8FC7 SSH \u542F\u52A8\u5B83\uFF0C\u83B7\u5F97 UDP \u96A7\u9053\u3001\u539F\u751F\u641C\u7D22\u7B49\u5B8C\u6574\u80FD\u529B",
  "field.cwd": "\u9ED8\u8BA4\u76EE\u5F55",
  "field.serial": "\u8BBE\u5907\u5E8F\u5217\u53F7",
  "field.serial.hint": "\u6765\u81EA adb devices\uFF0C\u4F8B\u5982 emulator-5554 \u6216 192.168.1.20:5555",
  "field.account": "\u8D26\u6237\u540D",
  "field.account.hint": "1\u201320 \u4E2A\u5B57\u6BCD\u3001\u6570\u5B57\u3001_ \u6216 -",
  "field.exclusive": "\u72EC\u5360\u4F7F\u7528",
  "field.exclusive.hint": "\u540C\u4E00\u65F6\u95F4\u53EA\u5141\u8BB8\u4E00\u4E2A\u4F1A\u8BDD\u4F7F\u7528\uFF0C\u5176\u4ED6\u4F1A\u8BDD\u6392\u961F\u7B49\u5F85",
  "field.borrowable": "\u5141\u8BB8\u501F\u7528",
  "field.kind": "\u7C7B\u578B",
  "dialog.add": "\u6DFB\u52A0\u73AF\u5883",
  "dialog.edit": "\u7F16\u8F91\u73AF\u5883",
  "dialog.delete.title": "\u5220\u9664\u73AF\u5883",
  "dialog.delete.body": "\u786E\u5B9A\u5220\u9664\u201C{name}\u201D\u5417\uFF1F\u6B63\u5728\u4F7F\u7528\u5B83\u7684\u4F1A\u8BDD\u4F1A\u7ACB\u5373\u65AD\u5F00\u3002",
  "dialog.account.title": "\u521B\u5EFA Windows \u6D4B\u8BD5\u8D26\u6237",
  "dialog.account.body": "\u5C06\u521B\u5EFA\u4E00\u4E2A\u53D7\u9650\u7684\u672C\u5730\u6807\u51C6\u8D26\u6237\uFF0C\u5E76\u6DFB\u52A0\u4E3A\u73AF\u5883\u3002Windows \u4F1A\u5F39\u51FA\u7BA1\u7406\u5458\u786E\u8BA4\u3002",
  "dialog.account.delete": "\u786E\u5B9A\u5220\u9664\u8D26\u6237\u201C{name}\u201D\u53CA\u5176\u7528\u6237\u914D\u7F6E\u6587\u4EF6\u5417\uFF1FWindows \u4F1A\u5F39\u51FA\u7BA1\u7406\u5458\u786E\u8BA4\u3002",
  "server.help.title": "\u5728\u76EE\u6807\u673A\u5668\u4E0A\u542F\u52A8\u670D\u52A1",
  "server.help.body": "\u628A dsh-env-server \u590D\u5236\u5230\u76EE\u6807\u673A\u5668\u5E76\u8FD0\u884C\u4E0B\u9762\u7684\u547D\u4EE4\uFF0C\u7136\u540E\u586B\u5199\u5B83\u6253\u5370\u7684\u5730\u5740\u548C\u4EE4\u724C\u3002",
  "browser.title": "\u9009\u62E9\u76EE\u5F55",
  "browser.title.workspace": "\u65B0\u5EFA\u8FDC\u7A0B\u5DE5\u4F5C\u533A",
  "browser.env": "\u73AF\u5883",
  "browser.path": "\u8DEF\u5F84",
  "browser.empty": "\u7A7A\u76EE\u5F55",
  "browser.loading": "\u6B63\u5728\u8BFB\u53D6\u2026",
  "browser.workspaceName": "\u5DE5\u4F5C\u533A\u540D\u79F0",
  "browser.folderName": "\u6587\u4EF6\u5939\u540D\u79F0",
  "browser.create": "\u521B\u5EFA\u5DE5\u4F5C\u533A",
  "browser.createAndOpen": "\u521B\u5EFA\u5E76\u5F00\u59CB\u4F1A\u8BDD",
  "browser.items": "{count} \u9879",
  "ws.root": "{env} \xB7 {root}",
  "lease.since": "{time}",
  "lease.tunnels": "{count} \u6761\u96A7\u9053",
  "lease.session": "\u4F1A\u8BDD {id}",
  "chip.label": "\u73AF\u5883",
  "chip.mounted": "\u5DF2\u6302\u8F7D\u5230 {name}",
  "chip.borrowed": "\u5DF2\u501F\u7528 {count} \u4E2A",
  "pop.mount": "\u6302\u8F7D",
  "pop.mount.hint": "\u628A\u8FD9\u4E2A\u4F1A\u8BDD\u7684\u6587\u4EF6\u4E0E\u547D\u4EE4\u5DE5\u5177\u63A5\u5230\u4E00\u4E2A\u73AF\u5883\u4E0A\u3002",
  "pop.mount.none": "\u672A\u6302\u8F7D \xB7 \u4F7F\u7528\u672C\u673A\u5DE5\u4F5C\u533A",
  "pop.mount.active": "{name}",
  "pop.mount.locked": "\u4F1A\u8BDD\u5DF2\u5F00\u59CB\uFF0C\u6302\u8F7D\u4E0D\u53EF\u66F4\u6539\u3002",
  "pop.mount.fromWorkspace": "\u6765\u81EA\u8FDC\u7A0B\u5DE5\u4F5C\u533A",
  "pop.mount.pick": "\u9009\u62E9\u73AF\u5883\u548C\u76EE\u5F55\u2026",
  "pop.mount.error": "\u6302\u8F7D\u5931\u8D25\uFF1A{message}",
  "pop.mount.pending": "\u5C06\u5728\u4F1A\u8BDD\u5F00\u59CB\u65F6\u6302\u8F7D",
  "pop.borrow": "\u53EF\u501F\u7528",
  "pop.borrow.hint": "\u667A\u80FD\u4F53\u53EF\u4EE5\u7528 env_borrow \u4E34\u65F6\u501F\u7528\u8FD9\u4E9B\u73AF\u5883\u3002",
  "pop.borrow.inherit.all": "\u9ED8\u8BA4\uFF1A\u5168\u90E8\u73AF\u5883",
  "pop.borrow.inherit.workspace": "\u7EE7\u627F\u81EA\u5DE5\u4F5C\u533A",
  "pop.borrow.custom": "\u672C\u4F1A\u8BDD\u81EA\u5B9A\u4E49",
  "pop.borrow.reset": "\u6062\u590D\u9ED8\u8BA4",
  "pop.borrow.saveWorkspace": "\u8BBE\u4E3A\u6B64\u5DE5\u4F5C\u533A\u9ED8\u8BA4",
  "pop.borrow.saved": "\u5DF2\u4FDD\u5B58\u4E3A\u5DE5\u4F5C\u533A\u9ED8\u8BA4",
  "pop.held": "\u5DF2\u501F\u7528",
  "pop.held.none": "\u5C1A\u672A\u501F\u7528\u4EFB\u4F55\u73AF\u5883",
  "pop.tools": "{count} \u4E2A\u5DE5\u5177",
  "err.generic": "\u64CD\u4F5C\u5931\u8D25\uFF1A{message}",
  "time.justNow": "\u521A\u521A",
  "time.minutes": "{n} \u5206\u949F\u524D",
  "time.hours": "{n} \u5C0F\u65F6\u524D",
  "info.os": "{os} \xB7 {arch}",
  "empty.title": "\u6DFB\u52A0\u7B2C\u4E00\u4E2A\u73AF\u5883",
  "empty.body": "\u8FDE\u63A5\u670D\u52A1\u5668\u3001\u624B\u673A\u6216\u6D4B\u8BD5\u8D26\u6237\uFF0C\u8BA9\u667A\u80FD\u4F53\u5728\u771F\u5B9E\u8BBE\u5907\u4E0A\u5DE5\u4F5C\u3002",
  "adb.error": "adb \u4E0D\u53EF\u7528\uFF1A{message}"
};
var en = {
  "panel": "Environments",
  "page.title": "Environments",
  "page.subtitle": "Let agents use other devices: mount one as the workspace, or borrow it when needed.",
  "action.refresh": "Refresh",
  "action.add": "Add environment",
  "action.test": "Test connection",
  "action.testing": "Connecting\u2026",
  "action.edit": "Edit",
  "action.delete": "Delete",
  "action.cancel": "Cancel",
  "action.save": "Save",
  "action.saveAndTest": "Save and test",
  "action.close": "Close",
  "action.newWorkspace": "New remote workspace",
  "action.browse": "Browse files",
  "action.release": "Release",
  "action.return": "Return",
  "action.newSession": "New session",
  "action.remove": "Remove",
  "action.addDevice": "Add to list",
  "action.create": "Create",
  "action.manage": "Manage environments\u2026",
  "action.apply": "Apply",
  "action.unmount": "Unmount",
  "action.choose": "Choose this folder",
  "action.up": "Up",
  "action.home": "Home",
  "action.newFolder": "New folder",
  "action.open": "Open",
  "action.retry": "Retry",
  "kind.local": "This computer",
  "kind.server": "Environment server",
  "kind.ssh": "SSH",
  "kind.adb": "Android (ADB)",
  "kind.winuser": "Windows account",
  "kind.local.desc": "The computer running dsh",
  "kind.server.desc": "A machine running dsh-env-server",
  "kind.ssh.desc": "A server reached over SSH",
  "kind.adb.desc": "A phone or emulator controlled through adb",
  "kind.winuser.desc": "A restricted test account on this computer that can run GUI programs",
  "section.environments": "Environments",
  "section.workspaces": "Remote workspaces",
  "section.workspaces.hint": "Sessions in a remote workspace read, write and run commands inside that environment.",
  "section.workspaces.empty": "No remote workspaces yet. Choose \u201CNew remote workspace\u201D on any environment card.",
  "section.leases": "In use",
  "section.leases.empty": "No session is using an environment right now.",
  "section.accounts": "Windows test accounts",
  "section.accounts.hint": "Restricted local standard accounts. Programs started as one appear on the current desktop so agents can test user interfaces. Creating and deleting needs administrator approval.",
  "section.accounts.empty": "No test accounts yet.",
  "status.available": "Available",
  "status.busy": "In use",
  "status.busyBy": "In use by {who}",
  "status.queue": "{count} waiting",
  "status.offline": "Offline",
  "status.unknown": "Not checked",
  "status.connected": "Reachable \xB7 {ms} ms",
  "status.failed": "Connection failed",
  "status.discovered": "Discovered",
  "status.builtin": "Built in",
  "status.shared": "Shared",
  "status.exclusive": "Exclusive",
  "badge.mount": "Mounted",
  "badge.borrow": "Borrowed",
  "field.name": "Name",
  "field.name.ph": "e.g. Test phone Pixel 8",
  "field.id": "Identifier",
  "field.id.hint": "Prefix of the tools an agent gets after borrowing, e.g. {alias}__screenshot",
  "field.description": "Notes",
  "field.host": "Host",
  "field.port": "Port",
  "field.token": "Token",
  "field.token.hint": "Printed by dsh-env-server at start, or set with --token",
  "field.username": "User name",
  "field.password": "Password",
  "field.password.hint": "Leave empty to use a key or ssh-agent",
  "field.privateKey": "Private key path",
  "field.privateKey.ph": "~/.ssh/id_ed25519",
  "field.passphrase": "Key passphrase",
  "field.serverPath": "Remote dsh-env-server path",
  "field.serverPath.hint": "Optional. When set it is started over SSH for full capabilities such as UDP tunnels and native search",
  "field.cwd": "Default directory",
  "field.serial": "Device serial",
  "field.serial.hint": "From adb devices, e.g. emulator-5554 or 192.168.1.20:5555",
  "field.account": "Account name",
  "field.account.hint": "1\u201320 letters, digits, _ or -",
  "field.exclusive": "Exclusive use",
  "field.exclusive.hint": "Only one session may use it at a time; others wait in line",
  "field.borrowable": "Allow borrowing",
  "field.kind": "Type",
  "dialog.add": "Add environment",
  "dialog.edit": "Edit environment",
  "dialog.delete.title": "Delete environment",
  "dialog.delete.body": "Delete \u201C{name}\u201D? Sessions using it are disconnected immediately.",
  "dialog.account.title": "Create Windows test account",
  "dialog.account.body": "A restricted local standard account is created and added as an environment. Windows asks for administrator approval.",
  "dialog.account.delete": "Delete the account \u201C{name}\u201D and its user profile? Windows asks for administrator approval.",
  "server.help.title": "Start the server on the target machine",
  "server.help.body": "Copy dsh-env-server to the target machine, run the command below, then enter the address and token it prints.",
  "browser.title": "Choose a folder",
  "browser.title.workspace": "New remote workspace",
  "browser.env": "Environment",
  "browser.path": "Path",
  "browser.empty": "Empty folder",
  "browser.loading": "Reading\u2026",
  "browser.workspaceName": "Workspace name",
  "browser.folderName": "Folder name",
  "browser.create": "Create workspace",
  "browser.createAndOpen": "Create and start session",
  "browser.items": "{count} items",
  "ws.root": "{env} \xB7 {root}",
  "lease.since": "{time}",
  "lease.tunnels": "{count} tunnels",
  "lease.session": "Session {id}",
  "chip.label": "Environment",
  "chip.mounted": "Mounted on {name}",
  "chip.borrowed": "{count} borrowed",
  "pop.mount": "Mount",
  "pop.mount.hint": "Connect this session\u2019s file and shell tools to an environment.",
  "pop.mount.none": "Not mounted \xB7 using the local workspace",
  "pop.mount.active": "{name}",
  "pop.mount.locked": "The session has started; its mount can no longer change.",
  "pop.mount.fromWorkspace": "From the remote workspace",
  "pop.mount.pick": "Choose environment and folder\u2026",
  "pop.mount.error": "Mount failed: {message}",
  "pop.mount.pending": "Mounts when the session starts",
  "pop.borrow": "Borrowable",
  "pop.borrow.hint": "The agent may borrow these environments with env_borrow.",
  "pop.borrow.inherit.all": "Default: every environment",
  "pop.borrow.inherit.workspace": "Inherited from the workspace",
  "pop.borrow.custom": "Customized for this session",
  "pop.borrow.reset": "Reset to default",
  "pop.borrow.saveWorkspace": "Make default for this workspace",
  "pop.borrow.saved": "Saved as the workspace default",
  "pop.held": "Borrowed",
  "pop.held.none": "Nothing borrowed yet",
  "pop.tools": "{count} tools",
  "err.generic": "Something went wrong: {message}",
  "time.justNow": "just now",
  "time.minutes": "{n} min ago",
  "time.hours": "{n} h ago",
  "info.os": "{os} \xB7 {arch}",
  "empty.title": "Add your first environment",
  "empty.body": "Connect a server, a phone or a test account so agents can work on real devices.",
  "adb.error": "adb is unavailable: {message}"
};
var dictionaries = { zh, en };

// src/client/styles.css
var styles_default = ".envx-page{display:flex;width:100%;height:100%;min-width:0;min-height:0;overflow:hidden;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-base);font-size:14px;line-height:1.6}\n.envx-scroll{flex:1;min-height:0;overflow:auto;scrollbar-gutter:stable}\n.envx-content{max-width:1040px;margin:0 auto;padding:0 clamp(24px,4vw,48px) 64px}\n.envx-heading{display:flex;align-items:flex-end;justify-content:space-between;gap:16px;padding-top:28px;margin-bottom:28px}\n.envx-heading h1{margin:0;font-size:22px;line-height:30px;font-weight:600;letter-spacing:-.01em}\n.envx-heading p{margin:4px 0 0;color:var(--dsw-alias-label-secondary);font-size:13px;line-height:20px}\n.envx-actions{display:flex;align-items:center;gap:8px;flex-shrink:0}\n.envx-section{margin-top:32px}\n.envx-section:first-of-type{margin-top:0}\n.envx-section-head{display:flex;align-items:baseline;justify-content:space-between;gap:12px;margin-bottom:12px}\n.envx-section-head h2{margin:0;font-size:14px;line-height:22px;font-weight:600}\n.envx-section-head p{margin:2px 0 0;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px;max-width:640px}\n.envx-count{margin-left:8px;color:var(--dsw-alias-label-tertiary);font-weight:400;font-variant-numeric:tabular-nums}\n.envx-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:12px}\n\n.envx-card{position:relative;display:flex;flex-direction:column;gap:12px;min-width:0;padding:16px;border-radius:14px;border:.5px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);transition:border-color .15s,box-shadow .15s}\n.envx-card:hover{border-color:var(--dsw-alias-border-l3);box-shadow:0 4px 18px color-mix(in srgb,var(--dsw-alias-label-primary) 6%,transparent)}\n.envx-card[data-dashed]{border-style:dashed;background:transparent}\n.envx-card-head{display:flex;align-items:flex-start;gap:12px;min-width:0}\n.envx-tile{flex:none;display:inline-flex;align-items:center;justify-content:center;width:38px;height:38px;border-radius:10px;color:var(--envx-accent);background:color-mix(in srgb,var(--envx-accent) 13%,transparent)}\n[data-kind=local]{--envx-accent:#4b83f0}\n[data-kind=server]{--envx-accent:#8b6cf0}\n[data-kind=ssh]{--envx-accent:#16a37b}\n[data-kind=adb]{--envx-accent:#3dba54}\n[data-kind=winuser]{--envx-accent:#1e9bd7}\n.envx-card-title{flex:1;min-width:0;display:flex;flex-direction:column}\n.envx-card-title strong{font-size:14px;line-height:20px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}\n.envx-sub{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}\n.envx-status{flex:none;display:inline-flex;align-items:center;gap:6px;height:22px;padding:0 8px 0 6px;border-radius:11px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-layer-2);white-space:nowrap;max-width:46%;overflow:hidden;text-overflow:ellipsis}\n.envx-status i{flex:none;width:7px;height:7px;border-radius:50%;background:var(--dsw-alias-label-dimmed,#aaa)}\n.envx-status[data-state=ok] i{background:var(--dsw-alias-state-success-primary)}\n.envx-status[data-state=busy]{color:var(--dsw-alias-state-warn-label,var(--dsw-alias-label-primary));background:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 14%,transparent)}\n.envx-status[data-state=busy] i{background:var(--dsw-alias-state-warn-primary)}\n.envx-status[data-state=error]{color:var(--dsw-alias-state-error-primary);background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 10%,transparent)}\n.envx-status[data-state=error] i{background:var(--dsw-alias-state-error-primary)}\n.envx-meta{display:flex;flex-wrap:wrap;gap:6px;min-height:22px;align-items:center}\n.envx-chip{display:inline-flex;align-items:center;gap:4px;height:22px;padding:0 8px;border-radius:6px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-layer-2);white-space:nowrap;max-width:100%;overflow:hidden;text-overflow:ellipsis}\n.envx-chip[data-tone=accent]{color:var(--dsw-alias-state-business-primary);background:color-mix(in srgb,var(--dsw-alias-state-business-primary) 10%,transparent)}\n.envx-chip code{font-family:var(--dsw-font-mono,ui-monospace,SFMono-Regular,Menlo,Consolas,monospace);font-size:11.5px}\n.envx-error-line{color:var(--dsw-alias-state-error-primary);font-size:12px;line-height:18px;overflow-wrap:anywhere}\n.envx-card-foot{display:flex;align-items:center;gap:6px;margin-top:auto;padding-top:4px}\n.envx-card-foot .envx-spacer{flex:1}\n.envx-iconbtn{appearance:none;display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;border:none;border-radius:8px;background:transparent;color:var(--dsw-alias-label-tertiary);cursor:pointer;transition:background .12s,color .12s}\n.envx-iconbtn:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}\n.envx-iconbtn[data-danger]:hover{background:var(--dsw-alias-interactive-bg-hover-danger,var(--dsw-alias-interactive-bg-hover));color:var(--dsw-alias-state-error-primary)}\n.envx-iconbtn:disabled{opacity:.4;cursor:default}\n.envx-linkbtn{appearance:none;display:inline-flex;align-items:center;gap:6px;height:28px;padding:0 10px;border:.5px solid var(--dsw-alias-border-l2);border-radius:8px;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:12.5px;cursor:pointer;white-space:nowrap;transition:background .12s,border-color .12s}\n.envx-linkbtn:hover{background:var(--dsw-alias-interactive-bg-hover);border-color:var(--dsw-alias-border-l3)}\n.envx-linkbtn:disabled{opacity:.5;cursor:default}\n.envx-linkbtn[data-primary]{border-color:transparent;color:var(--dsw-alias-label-primary-foreground,#fff);background:var(--dsw-alias-button-primary-fill,var(--dsw-alias-brand-primary))}\n.envx-linkbtn[data-primary]:hover{background:var(--dsw-alias-button-primary-hover,var(--dsw-alias-brand-primary))}\n\n.envx-list{border:.5px solid var(--dsw-alias-border-l2);border-radius:14px;background:var(--dsw-alias-bg-layer-1);overflow:hidden}\n.envx-row{display:flex;align-items:center;gap:12px;min-height:56px;padding:10px 14px 10px 16px}\n.envx-row + .envx-row{border-top:.5px solid var(--dsw-alias-border-l1)}\n.envx-row-main{flex:1;min-width:0;display:flex;flex-direction:column}\n.envx-row-main strong{font-size:13.5px;line-height:20px;font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}\n.envx-row-main span{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}\n.envx-row .envx-tile{width:32px;height:32px;border-radius:9px}\n.envx-empty{padding:22px 16px;color:var(--dsw-alias-label-tertiary);font-size:13px;text-align:center;border:.5px dashed var(--dsw-alias-border-l2);border-radius:14px}\n.envx-banner{display:flex;gap:8px;align-items:flex-start;margin-bottom:16px;padding:10px 12px;border-radius:10px;font-size:13px;line-height:20px;color:var(--dsw-alias-state-error-primary);background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 8%,transparent);overflow-wrap:anywhere}\n.envx-banner[data-tone=info]{color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-layer-2)}\n.envx-spin{animation:envx-spin .9s linear infinite}\n@keyframes envx-spin{to{transform:rotate(360deg)}}\n\n/* dialogs */\n.envx-dialog{width:min(560px,calc(100vw - 48px))}\n.envx-dialog-wide{width:min(720px,calc(100vw - 48px))}\n.envx-form{display:flex;flex-direction:column;gap:14px}\n.envx-field{display:flex;flex-direction:column;gap:6px;min-width:0}\n.envx-field > label{font-size:12.5px;line-height:18px;color:var(--dsw-alias-label-secondary);font-weight:500}\n.envx-field small{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:17px}\n.envx-field-row{display:grid;grid-template-columns:1fr 120px;gap:12px}\n.envx-field-row[data-even]{grid-template-columns:1fr 1fr}\n.envx-input{box-sizing:border-box;width:100%;height:34px;padding:0 10px;border-radius:8px;border:.5px solid var(--dsw-alias-border-l3);background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font:inherit;font-size:13.5px;outline:none;transition:border-color .12s,box-shadow .12s}\n.envx-input:focus{border-color:var(--dsw-alias-state-business-primary);box-shadow:0 0 0 3px color-mix(in srgb,var(--dsw-alias-state-business-primary) 16%,transparent)}\n.envx-input::placeholder{color:var(--dsw-alias-label-dimmed,var(--dsw-alias-label-tertiary))}\n.envx-input[data-mono]{font-family:var(--dsw-font-mono,ui-monospace,SFMono-Regular,Menlo,Consolas,monospace);font-size:12.5px}\nselect.envx-input{appearance:none;padding-right:28px;background-image:linear-gradient(45deg,transparent 50%,currentColor 50%),linear-gradient(135deg,currentColor 50%,transparent 50%);background-position:calc(100% - 15px) 14px,calc(100% - 10px) 14px;background-size:5px 5px;background-repeat:no-repeat}\n.envx-switch-row{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:10px 12px;border-radius:10px;background:var(--dsw-alias-bg-layer-2)}\n.envx-switch-row div{display:flex;flex-direction:column;min-width:0}\n.envx-switch-row span{font-size:13px;line-height:20px}\n.envx-switch-row small{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:17px}\n.envx-kinds{display:grid;grid-template-columns:1fr 1fr;gap:10px}\n.envx-kind{appearance:none;display:flex;gap:12px;align-items:flex-start;text-align:left;padding:14px;border-radius:12px;border:.5px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);color:inherit;font:inherit;cursor:pointer;transition:border-color .12s,background .12s,transform .12s}\n.envx-kind:hover{border-color:var(--envx-accent);background:color-mix(in srgb,var(--envx-accent) 5%,var(--dsw-alias-bg-layer-1))}\n.envx-kind:active{transform:scale(.99)}\n.envx-kind strong{display:block;font-size:13.5px;line-height:20px;font-weight:600}\n.envx-kind span span{display:block;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:17px}\n.envx-help{padding:12px;border-radius:10px;background:var(--dsw-alias-bg-layer-2);font-size:12.5px;line-height:19px;color:var(--dsw-alias-label-secondary)}\n.envx-help strong{display:block;color:var(--dsw-alias-label-primary);font-weight:600;margin-bottom:2px}\n.envx-help code{display:block;margin-top:8px;padding:8px 10px;border-radius:8px;background:var(--dsw-alias-markdown-code-block,var(--dsw-alias-bg-base));color:var(--dsw-alias-label-primary);font-family:var(--dsw-font-mono,ui-monospace,SFMono-Regular,Menlo,Consolas,monospace);font-size:12px;overflow-x:auto;white-space:nowrap;user-select:all}\n.envx-result{display:flex;gap:8px;align-items:flex-start;padding:10px 12px;border-radius:10px;font-size:12.5px;line-height:19px;overflow-wrap:anywhere}\n.envx-result[data-ok=true]{color:var(--dsw-alias-state-success-primary);background:color-mix(in srgb,var(--dsw-alias-state-success-primary) 10%,transparent)}\n.envx-result[data-ok=false]{color:var(--dsw-alias-state-error-primary);background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 8%,transparent)}\n.envx-footer{width:100%;display:flex;justify-content:flex-end;gap:8px;align-items:center}\n.envx-footer .envx-spacer{flex:1}\n\n/* remote browser */\n.envx-browser{display:flex;flex-direction:column;gap:12px;min-height:0}\n.envx-browser-bar{display:flex;gap:8px;align-items:center}\n.envx-browser-bar select{flex:none;width:200px}\n.envx-browser-list{height:320px;overflow:auto;border:.5px solid var(--dsw-alias-border-l2);border-radius:10px;background:var(--dsw-alias-bg-base)}\n.envx-entry{appearance:none;display:flex;align-items:center;gap:10px;width:100%;height:34px;padding:0 12px;border:none;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;text-align:left;cursor:pointer}\n.envx-entry:hover{background:var(--dsw-alias-interactive-bg-hover)}\n.envx-entry[data-type=file]{color:var(--dsw-alias-label-tertiary);cursor:default}\n.envx-entry[data-type=file]:hover{background:transparent}\n.envx-entry svg{flex:none;color:var(--dsw-alias-label-tertiary)}\n.envx-entry[data-type=dir] svg{color:#e0a43a}\n.envx-entry span{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}\n.envx-entry em{flex:none;font-style:normal;color:var(--dsw-alias-label-tertiary);font-size:12px;font-variant-numeric:tabular-nums}\n.envx-browser-state{display:flex;align-items:center;justify-content:center;gap:8px;height:100%;color:var(--dsw-alias-label-tertiary);font-size:13px;padding:0 24px;text-align:center}\n.envx-crumbs{display:flex;align-items:center;gap:2px;min-width:0;flex:1;height:34px;padding:0 6px;border-radius:8px;border:.5px solid var(--dsw-alias-border-l3);background:var(--dsw-alias-bg-base);overflow:hidden}\n.envx-crumbs input{flex:1;min-width:0;height:100%;border:none;outline:none;background:transparent;color:var(--dsw-alias-label-primary);font-family:var(--dsw-font-mono,ui-monospace,SFMono-Regular,Menlo,Consolas,monospace);font-size:12.5px}\n\n/* composer chip + popover */\n.envx-chipbtn{appearance:none;display:inline-flex;align-items:center;gap:6px;height:28px;padding:0 8px;border:none;border-radius:8px;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:13px;line-height:20px;cursor:pointer;white-space:nowrap;max-width:220px;transition:background .12s,color .12s}\n.envx-chipbtn:hover,.envx-chipbtn[aria-expanded=true]{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}\n.envx-chipbtn[data-active]{color:var(--dsw-alias-state-business-primary)}\n.envx-chipbtn span{overflow:hidden;text-overflow:ellipsis}\n.envx-chipbtn b{font-weight:500;display:inline-flex;align-items:center;justify-content:center;min-width:16px;height:16px;padding:0 4px;border-radius:8px;font-size:11px;line-height:16px;color:var(--dsw-alias-label-primary-foreground,#fff);background:var(--dsw-alias-state-business-primary)}\n.envx-pop{position:fixed;z-index:1000;width:340px;max-height:min(560px,calc(100vh - 32px));overflow:auto;padding:6px;border-radius:14px;border:.5px solid var(--dsw-alias-border-l2);background:color-mix(in srgb,var(--dsw-alias-bg-layer-1) 92%,transparent);backdrop-filter:blur(24px);box-shadow:0 12px 40px color-mix(in srgb,#000 18%,transparent);color:var(--dsw-alias-label-primary);font-size:13px;line-height:20px;animation:envx-pop .12s ease-out}\n@keyframes envx-pop{from{opacity:0;transform:translateY(4px)}}\n.envx-pop-section{padding:10px 10px 8px}\n.envx-pop-section + .envx-pop-section{border-top:.5px solid var(--dsw-alias-border-l1)}\n.envx-pop-title{display:flex;align-items:center;justify-content:space-between;gap:8px;font-size:12px;line-height:18px;font-weight:600;color:var(--dsw-alias-label-secondary);text-transform:none;margin-bottom:6px}\n.envx-pop-title small{font-weight:400;color:var(--dsw-alias-label-tertiary)}\n.envx-pop-hint{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:17px;margin:0 0 8px}\n.envx-pop-item{display:flex;align-items:center;gap:10px;min-height:36px;padding:4px 6px;border-radius:8px}\n.envx-pop-item[data-click]{cursor:pointer}\n.envx-pop-item[data-click]:hover{background:var(--dsw-alias-interactive-bg-hover)}\n.envx-pop-item .envx-tile{width:26px;height:26px;border-radius:7px}\n.envx-pop-item-main{flex:1;min-width:0;display:flex;flex-direction:column}\n.envx-pop-item-main strong{font-weight:500;font-size:13px;line-height:18px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}\n.envx-pop-item-main span{color:var(--dsw-alias-label-tertiary);font-size:11.5px;line-height:16px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}\n.envx-check{flex:none;display:inline-flex;align-items:center;justify-content:center;width:16px;height:16px;border-radius:5px;border:1px solid var(--dsw-alias-border-l4,var(--dsw-alias-border-l3));color:transparent;transition:background .1s,border-color .1s}\n.envx-check[data-on]{background:var(--dsw-alias-state-business-primary);border-color:var(--dsw-alias-state-business-primary);color:#fff}\n.envx-pop-foot{display:flex;flex-wrap:wrap;gap:6px;margin-top:8px}\n.envx-textbtn{appearance:none;border:none;background:transparent;padding:2px 6px;border-radius:6px;color:var(--dsw-alias-state-business-primary);font:inherit;font-size:12px;cursor:pointer}\n.envx-textbtn:hover{background:color-mix(in srgb,var(--dsw-alias-state-business-primary) 10%,transparent)}\n.envx-textbtn[data-quiet]{color:var(--dsw-alias-label-tertiary)}\n.envx-textbtn[data-quiet]:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}\n.envx-textbtn:disabled{opacity:.5;cursor:default}\n.envx-mounted{display:flex;align-items:center;gap:10px;padding:8px;border-radius:10px;background:color-mix(in srgb,var(--dsw-alias-state-business-primary) 8%,transparent)}\n.envx-hero{display:flex;flex-direction:column;align-items:center;gap:6px;padding:40px 16px;border:.5px dashed var(--dsw-alias-border-l2);border-radius:14px;text-align:center}\n.envx-hero strong{font-size:14px;font-weight:600}\n.envx-hero span{color:var(--dsw-alias-label-tertiary);font-size:13px}\n";

// src/client/page.jsx
var React4 = __toESM(require("react"), 1);
var import_react4 = require("react");
var import_dsh_client_ui_primitives3 = require("@deepseek-ai/dsh-client-ui-primitives");

// src/client/api.js
var import_react = require("react");
var ROUTE = "api/environments";
async function call(action, body = {}, signal) {
  const response = await fetch(ROUTE, {
    method: "POST",
    credentials: "same-origin",
    cache: "no-store",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action, ...body }),
    signal
  });
  let data;
  try {
    data = await response.json();
  } catch {
    throw new Error(`HTTP ${response.status}`);
  }
  if (!data.ok) {
    const error = new Error(data.error ?? `HTTP ${response.status}`);
    error.code = data.code;
    throw error;
  }
  return data.value;
}
var listeners = /* @__PURE__ */ new Set();
function invalidate() {
  for (const l of listeners) l();
}
function useEnvState(sessionId, { intervalMs = 4e3, discover = false } = {}) {
  const [state, setState] = (0, import_react.useState)({ data: void 0, error: void 0, loading: true });
  const [tick, setTick] = (0, import_react.useState)(0);
  const refresh = (0, import_react.useCallback)(() => setTick((v) => v + 1), []);
  const first = (0, import_react.useRef)(true);
  (0, import_react.useEffect)(() => {
    listeners.add(refresh);
    return () => listeners.delete(refresh);
  }, [refresh]);
  (0, import_react.useEffect)(() => {
    let disposed = false;
    let timer;
    const controller = new AbortController();
    const load = async () => {
      try {
        const data = await call("state", { sessionId, discover: discover && first.current }, controller.signal);
        first.current = false;
        if (!disposed) setState({ data, error: void 0, loading: false });
      } catch (error) {
        if (disposed || controller.signal.aborted) return;
        setState((prev) => ({ ...prev, error: error.message, loading: false }));
      }
      if (!disposed) timer = setTimeout(() => {
        if (document.visibilityState === "visible") load();
        else timer = setTimeout(load, intervalMs);
      }, intervalMs);
    };
    load();
    return () => {
      disposed = true;
      controller.abort();
      clearTimeout(timer);
    };
  }, [sessionId, tick, intervalMs, discover]);
  return { ...state, refresh };
}
function useAction() {
  const [busy, setBusy] = (0, import_react.useState)(false);
  const [error, setError] = (0, import_react.useState)(void 0);
  const mounted = (0, import_react.useRef)(true);
  (0, import_react.useEffect)(() => () => {
    mounted.current = false;
  }, []);
  const run = (0, import_react.useCallback)(async (fn) => {
    setBusy(true);
    setError(void 0);
    try {
      const value = await fn();
      invalidate();
      return value;
    } catch (e) {
      if (mounted.current) setError(e.message);
      return void 0;
    } finally {
      if (mounted.current) setBusy(false);
    }
  }, []);
  return { busy, error, run, clearError: () => setError(void 0) };
}

// src/client/env-dialog.jsx
var React2 = __toESM(require("react"), 1);
var import_react2 = require("react");
var import_dsh_client_ui_primitives = require("@deepseek-ai/dsh-client-ui-primitives");

// src/client/icons.jsx
var React = __toESM(require("react"), 1);
var base = { width: 20, height: 20, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.6, strokeLinecap: "round", strokeLinejoin: "round" };
function Svg({ size = 20, children, ...rest }) {
  return /* @__PURE__ */ React.createElement("svg", { ...base, width: size, height: size, "aria-hidden": "true", ...rest }, children);
}
function IconEnvironments({ size }) {
  return /* @__PURE__ */ React.createElement(Svg, { size }, /* @__PURE__ */ React.createElement("rect", { x: "3", y: "4", width: "12", height: "9", rx: "1.6" }), /* @__PURE__ */ React.createElement("path", { d: "M7 17h4M9 13v4" }), /* @__PURE__ */ React.createElement("rect", { x: "16", y: "9", width: "5", height: "11", rx: "1.4" }), /* @__PURE__ */ React.createElement("path", { d: "M18 17.5h1" }));
}
function IconLocal({ size }) {
  return /* @__PURE__ */ React.createElement(Svg, { size }, /* @__PURE__ */ React.createElement("rect", { x: "3", y: "4", width: "18", height: "12", rx: "2" }), /* @__PURE__ */ React.createElement("path", { d: "M8 20h8M12 16v4" }));
}
function IconServer({ size }) {
  return /* @__PURE__ */ React.createElement(Svg, { size }, /* @__PURE__ */ React.createElement("rect", { x: "3", y: "4", width: "18", height: "7", rx: "1.8" }), /* @__PURE__ */ React.createElement("rect", { x: "3", y: "13", width: "18", height: "7", rx: "1.8" }), /* @__PURE__ */ React.createElement("path", { d: "M7 7.5h.01M7 16.5h.01M11 7.5h6M11 16.5h6" }));
}
function IconSsh({ size }) {
  return /* @__PURE__ */ React.createElement(Svg, { size }, /* @__PURE__ */ React.createElement("rect", { x: "3", y: "4", width: "18", height: "16", rx: "2.2" }), /* @__PURE__ */ React.createElement("path", { d: "m7 9 3 3-3 3M12.5 15H17" }));
}
function IconPhone({ size }) {
  return /* @__PURE__ */ React.createElement(Svg, { size }, /* @__PURE__ */ React.createElement("rect", { x: "6.5", y: "2.5", width: "11", height: "19", rx: "2.4" }), /* @__PURE__ */ React.createElement("path", { d: "M10.5 18.5h3" }));
}
function IconWindows({ size }) {
  return /* @__PURE__ */ React.createElement(Svg, { size }, /* @__PURE__ */ React.createElement("path", { d: "M4 5.5 11 4.4V11H4zM13 4.1 20 3v8h-7zM4 13h7v6.6L4 18.5zM13 13h7v8l-7-1.1z" }));
}
function IconFolder({ size }) {
  return /* @__PURE__ */ React.createElement(Svg, { size }, /* @__PURE__ */ React.createElement("path", { d: "M3 7.2A2.2 2.2 0 0 1 5.2 5h3.6l2 2.2h8A2.2 2.2 0 0 1 21 9.4v7.4A2.2 2.2 0 0 1 18.8 19H5.2A2.2 2.2 0 0 1 3 16.8z" }));
}
function IconFile({ size }) {
  return /* @__PURE__ */ React.createElement(Svg, { size }, /* @__PURE__ */ React.createElement("path", { d: "M7 3h7l4 4v12.5A1.5 1.5 0 0 1 16.5 21h-9A1.5 1.5 0 0 1 6 19.5v-15A1.5 1.5 0 0 1 7.5 3z" }), /* @__PURE__ */ React.createElement("path", { d: "M14 3v4h4" }));
}
function IconPlus({ size }) {
  return /* @__PURE__ */ React.createElement(Svg, { size }, /* @__PURE__ */ React.createElement("path", { d: "M12 5v14M5 12h14" }));
}
function IconRefresh({ size }) {
  return /* @__PURE__ */ React.createElement(Svg, { size }, /* @__PURE__ */ React.createElement("path", { d: "M20 11a8 8 0 0 0-14.6-4M4 4v4h4M4 13a8 8 0 0 0 14.6 4M20 20v-4h-4" }));
}
function IconTrash({ size }) {
  return /* @__PURE__ */ React.createElement(Svg, { size }, /* @__PURE__ */ React.createElement("path", { d: "M4 7h16M10 11v6M14 11v6M6 7l1 12.2A2 2 0 0 0 9 21h6a2 2 0 0 0 2-1.8L18 7M9 7V4.8A.8.8 0 0 1 9.8 4h4.4a.8.8 0 0 1 .8.8V7" }));
}
function IconEdit({ size }) {
  return /* @__PURE__ */ React.createElement(Svg, { size }, /* @__PURE__ */ React.createElement("path", { d: "m14.5 5.5 4 4M4 20l1-4.5L16.3 4.2a1.7 1.7 0 0 1 2.4 0l1.1 1.1a1.7 1.7 0 0 1 0 2.4L8.5 19z" }));
}
function IconPlug({ size }) {
  return /* @__PURE__ */ React.createElement(Svg, { size }, /* @__PURE__ */ React.createElement("path", { d: "M9 3v5M15 3v5M7 8h10v3a5 5 0 0 1-10 0zM12 16v5" }));
}
function IconUp({ size }) {
  return /* @__PURE__ */ React.createElement(Svg, { size }, /* @__PURE__ */ React.createElement("path", { d: "M12 19V6M6 11l6-6 6 6" }));
}
function IconHome({ size }) {
  return /* @__PURE__ */ React.createElement(Svg, { size }, /* @__PURE__ */ React.createElement("path", { d: "m4 11 8-7 8 7M6 10v9h12v-9" }));
}
function IconCheck({ size }) {
  return /* @__PURE__ */ React.createElement(Svg, { size }, /* @__PURE__ */ React.createElement("path", { d: "m5 12.5 4.5 4.5L19 7.5" }));
}
function IconMount({ size }) {
  return /* @__PURE__ */ React.createElement(Svg, { size }, /* @__PURE__ */ React.createElement("path", { d: "M12 3v10M8 9l4 4 4-4" }), /* @__PURE__ */ React.createElement("rect", { x: "4", y: "15", width: "16", height: "6", rx: "1.8" }), /* @__PURE__ */ React.createElement("path", { d: "M8 18h.01" }));
}
function IconSpinner({ size }) {
  return /* @__PURE__ */ React.createElement(Svg, { size, className: "envx-spin" }, /* @__PURE__ */ React.createElement("path", { d: "M12 3a9 9 0 1 0 9 9" }));
}
var KIND_ICON = { local: IconLocal, server: IconServer, ssh: IconSsh, adb: IconPhone, winuser: IconWindows };
function KindIcon({ kind, size = 20 }) {
  const C = KIND_ICON[kind] ?? IconServer;
  return /* @__PURE__ */ React.createElement(C, { size });
}

// src/client/env-dialog.jsx
var ADDABLE = ["server", "ssh", "adb", "winuser"];
function aliasOf(name) {
  let a = String(name).toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 24) || "env";
  if (!/^[a-z]/.test(a)) a = `env_${a}`;
  return a;
}
function Field({ label, hint, children }) {
  return /* @__PURE__ */ React2.createElement("div", { className: "envx-field" }, /* @__PURE__ */ React2.createElement("label", null, label), children, hint && /* @__PURE__ */ React2.createElement("small", null, hint));
}
function TextInput({ value, onChange, mono, ...rest }) {
  return /* @__PURE__ */ React2.createElement("input", { className: "envx-input", "data-mono": mono ? "" : void 0, value: value ?? "", onChange: (e) => onChange(e.target.value), spellCheck: false, autoComplete: "off", ...rest });
}
var DEFAULTS = {
  server: { port: 7461 },
  ssh: { port: 22 },
  adb: {},
  winuser: {}
};
function EnvDialog({ open, environment, platform, onClose, t }) {
  const editing = !!environment;
  const [kind, setKind] = (0, import_react2.useState)(environment?.kind);
  const [name, setName] = (0, import_react2.useState)("");
  const [id, setId] = (0, import_react2.useState)("");
  const [idTouched, setIdTouched] = (0, import_react2.useState)(false);
  const [description, setDescription] = (0, import_react2.useState)("");
  const [config, setConfig] = (0, import_react2.useState)({});
  const [exclusive, setExclusive] = (0, import_react2.useState)(false);
  const [busy, setBusy] = (0, import_react2.useState)(false);
  const [result, setResult] = (0, import_react2.useState)(void 0);
  (0, import_react2.useEffect)(() => {
    if (!open) return;
    setKind(environment?.kind);
    setName(environment?.name ?? "");
    setId(environment?.id ?? "");
    setIdTouched(!!environment);
    setDescription(environment?.description ?? "");
    setConfig(environment?.config ?? {});
    setExclusive(environment?.exclusive ?? false);
    setResult(void 0);
    setBusy(false);
  }, [open, environment]);
  const choose = (k) => {
    setKind(k);
    setConfig({ ...DEFAULTS[k] });
    setExclusive(k === "adb" || k === "winuser");
  };
  const set = (key, value) => setConfig((c) => ({ ...c, [key]: value }));
  const effectiveId = idTouched ? id : aliasOf(name || kind || "env");
  const kinds = ADDABLE.filter((k) => k !== "winuser" || platform === "win32");
  const valid = kind && name.trim() && (kind === "server" && config.host && config.port || kind === "ssh" && config.host || kind === "adb" && config.serial || kind === "winuser" && config.account);
  const save = async () => {
    setBusy(true);
    setResult(void 0);
    try {
      let saved;
      if (kind === "winuser" && !editing) {
        saved = (await call("winuser.create", { name: config.account, environmentName: name.trim() })).environment;
      } else {
        saved = (await call("save", { environment: { id: effectiveId, name: name.trim(), kind, description, exclusive, config } })).environment;
      }
      invalidate();
      const test = await call("test", { id: saved.id });
      invalidate();
      if (test.ok) {
        setResult({ ok: true, text: t("status.connected", { ms: test.ms }) + (test.info ? ` \u2014 ${test.info.os}${test.info.arch ? ` \xB7 ${test.info.arch}` : ""}${test.info.user ? ` \xB7 ${test.info.user}` : ""}` : "") });
        setTimeout(onClose, 900);
      } else {
        setResult({ ok: false, text: test.error });
        setIdTouched(true);
        setId(saved.id);
      }
    } catch (e) {
      setResult({ ok: false, text: e.message });
    } finally {
      setBusy(false);
    }
  };
  const footer = kind ? /* @__PURE__ */ React2.createElement("div", { className: "envx-footer" }, !editing && /* @__PURE__ */ React2.createElement(import_dsh_client_ui_primitives.Button, { variant: "ghost", onClick: () => {
    setKind(void 0);
    setResult(void 0);
  } }, "\u2039 ", t("field.kind")), /* @__PURE__ */ React2.createElement("span", { className: "envx-spacer" }), /* @__PURE__ */ React2.createElement(import_dsh_client_ui_primitives.Button, { variant: "ghost", onClick: onClose }, t("action.cancel")), /* @__PURE__ */ React2.createElement(import_dsh_client_ui_primitives.Button, { variant: "primary", disabled: !valid || busy, onClick: save }, busy ? t("action.testing") : t("action.saveAndTest"))) : void 0;
  return /* @__PURE__ */ React2.createElement(import_dsh_client_ui_primitives.Modal, { open, onClose, title: editing ? t("dialog.edit") : t("dialog.add"), closeLabel: t("action.close"), footer, className: "envx-dialog" }, !kind && /* @__PURE__ */ React2.createElement("div", { className: "envx-kinds" }, kinds.map((k) => /* @__PURE__ */ React2.createElement("button", { type: "button", key: k, className: "envx-kind", "data-kind": k, onClick: () => choose(k) }, /* @__PURE__ */ React2.createElement("span", { className: "envx-tile", "data-kind": k }, /* @__PURE__ */ React2.createElement(KindIcon, { kind: k })), /* @__PURE__ */ React2.createElement("span", null, /* @__PURE__ */ React2.createElement("strong", null, t(`kind.${k}`)), /* @__PURE__ */ React2.createElement("span", null, t(`kind.${k}.desc`)))))), kind && /* @__PURE__ */ React2.createElement("div", { className: "envx-form", "data-kind": kind }, /* @__PURE__ */ React2.createElement("div", { className: "envx-field-row", "data-even": "" }, /* @__PURE__ */ React2.createElement(Field, { label: t("field.name") }, /* @__PURE__ */ React2.createElement(TextInput, { value: name, onChange: setName, placeholder: t("field.name.ph"), "data-modal-autofocus": "" })), /* @__PURE__ */ React2.createElement(Field, { label: t("field.id") }, /* @__PURE__ */ React2.createElement(TextInput, { value: effectiveId, mono: true, disabled: editing, onChange: (v) => {
    setId(v.replace(/[^A-Za-z0-9_.-]/g, ""));
    setIdTouched(true);
  } }))), !editing && /* @__PURE__ */ React2.createElement("small", { style: { marginTop: -8, color: "var(--dsw-alias-label-tertiary)", fontSize: 12 } }, t("field.id.hint", { alias: aliasOf(effectiveId) })), kind === "server" && /* @__PURE__ */ React2.createElement(React2.Fragment, null, /* @__PURE__ */ React2.createElement("div", { className: "envx-field-row" }, /* @__PURE__ */ React2.createElement(Field, { label: t("field.host") }, /* @__PURE__ */ React2.createElement(TextInput, { value: config.host, onChange: (v) => set("host", v), placeholder: "192.168.1.20", mono: true })), /* @__PURE__ */ React2.createElement(Field, { label: t("field.port") }, /* @__PURE__ */ React2.createElement(TextInput, { value: config.port, onChange: (v) => set("port", v.replace(/\D/g, "")), inputMode: "numeric", mono: true }))), /* @__PURE__ */ React2.createElement(Field, { label: t("field.token"), hint: t("field.token.hint") }, /* @__PURE__ */ React2.createElement(TextInput, { value: config.token, onChange: (v) => set("token", v), type: "password", mono: true })), /* @__PURE__ */ React2.createElement("div", { className: "envx-help" }, /* @__PURE__ */ React2.createElement("strong", null, t("server.help.title")), t("server.help.body"), /* @__PURE__ */ React2.createElement("code", null, "dsh-env-server serve --listen 0.0.0.0:7461"))), kind === "ssh" && /* @__PURE__ */ React2.createElement(React2.Fragment, null, /* @__PURE__ */ React2.createElement("div", { className: "envx-field-row" }, /* @__PURE__ */ React2.createElement(Field, { label: t("field.host") }, /* @__PURE__ */ React2.createElement(TextInput, { value: config.host, onChange: (v) => set("host", v), placeholder: "build.example.com", mono: true })), /* @__PURE__ */ React2.createElement(Field, { label: t("field.port") }, /* @__PURE__ */ React2.createElement(TextInput, { value: config.port, onChange: (v) => set("port", v.replace(/\D/g, "")), inputMode: "numeric", mono: true }))), /* @__PURE__ */ React2.createElement("div", { className: "envx-field-row", "data-even": "" }, /* @__PURE__ */ React2.createElement(Field, { label: t("field.username") }, /* @__PURE__ */ React2.createElement(TextInput, { value: config.username, onChange: (v) => set("username", v), mono: true })), /* @__PURE__ */ React2.createElement(Field, { label: t("field.password") }, /* @__PURE__ */ React2.createElement(TextInput, { value: config.password, onChange: (v) => set("password", v), type: "password" }))), /* @__PURE__ */ React2.createElement("small", { style: { marginTop: -8, color: "var(--dsw-alias-label-tertiary)", fontSize: 12 } }, t("field.password.hint")), /* @__PURE__ */ React2.createElement("div", { className: "envx-field-row", "data-even": "" }, /* @__PURE__ */ React2.createElement(Field, { label: t("field.privateKey") }, /* @__PURE__ */ React2.createElement(TextInput, { value: config.privateKeyPath, onChange: (v) => set("privateKeyPath", v), placeholder: t("field.privateKey.ph"), mono: true })), /* @__PURE__ */ React2.createElement(Field, { label: t("field.passphrase") }, /* @__PURE__ */ React2.createElement(TextInput, { value: config.passphrase, onChange: (v) => set("passphrase", v), type: "password" }))), /* @__PURE__ */ React2.createElement(Field, { label: t("field.cwd") }, /* @__PURE__ */ React2.createElement(TextInput, { value: config.cwd, onChange: (v) => set("cwd", v), placeholder: "/home/me/project", mono: true })), /* @__PURE__ */ React2.createElement(Field, { label: t("field.serverPath"), hint: t("field.serverPath.hint") }, /* @__PURE__ */ React2.createElement(TextInput, { value: config.serverPath, onChange: (v) => set("serverPath", v), placeholder: "/usr/local/bin/dsh-env-server", mono: true }))), kind === "adb" && /* @__PURE__ */ React2.createElement(Field, { label: t("field.serial"), hint: t("field.serial.hint") }, /* @__PURE__ */ React2.createElement(TextInput, { value: config.serial, onChange: (v) => set("serial", v), placeholder: "emulator-5554", mono: true })), kind === "winuser" && /* @__PURE__ */ React2.createElement(React2.Fragment, null, /* @__PURE__ */ React2.createElement(Field, { label: t("field.account"), hint: t("field.account.hint") }, /* @__PURE__ */ React2.createElement(TextInput, { value: config.account, disabled: editing, onChange: (v) => set("account", v.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 20)), placeholder: "dsh-test", mono: true })), !editing && /* @__PURE__ */ React2.createElement("div", { className: "envx-help" }, /* @__PURE__ */ React2.createElement("strong", null, t("dialog.account.title")), t("dialog.account.body"))), /* @__PURE__ */ React2.createElement(Field, { label: t("field.description") }, /* @__PURE__ */ React2.createElement(TextInput, { value: description, onChange: setDescription })), /* @__PURE__ */ React2.createElement("div", { className: "envx-switch-row" }, /* @__PURE__ */ React2.createElement("div", null, /* @__PURE__ */ React2.createElement("span", null, t("field.exclusive")), /* @__PURE__ */ React2.createElement("small", null, t("field.exclusive.hint"))), /* @__PURE__ */ React2.createElement(import_dsh_client_ui_primitives.Switch, { checked: exclusive, onChange: setExclusive, label: t("field.exclusive") })), result && /* @__PURE__ */ React2.createElement("div", { className: "envx-result", "data-ok": String(result.ok) }, result.ok ? /* @__PURE__ */ React2.createElement(IconCheck, { size: 16 }) : null, /* @__PURE__ */ React2.createElement("span", null, result.text)), busy && !result && /* @__PURE__ */ React2.createElement("div", { className: "envx-result", "data-ok": "true", style: { color: "var(--dsw-alias-label-secondary)", background: "var(--dsw-alias-bg-layer-2)" } }, /* @__PURE__ */ React2.createElement(IconSpinner, { size: 16 }), /* @__PURE__ */ React2.createElement("span", null, t("action.testing")))));
}
function ConfirmDialog({ open, title, body, confirmLabel, danger, onConfirm, onClose, t }) {
  const [busy, setBusy] = (0, import_react2.useState)(false);
  const [error, setError] = (0, import_react2.useState)(void 0);
  (0, import_react2.useEffect)(() => {
    if (open) {
      setBusy(false);
      setError(void 0);
    }
  }, [open]);
  const go = async () => {
    setBusy(true);
    setError(void 0);
    try {
      await onConfirm();
      invalidate();
      onClose();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };
  return /* @__PURE__ */ React2.createElement(
    import_dsh_client_ui_primitives.Modal,
    {
      open,
      onClose,
      title,
      closeLabel: t("action.close"),
      className: "envx-dialog",
      footer: /* @__PURE__ */ React2.createElement("div", { className: "envx-footer" }, /* @__PURE__ */ React2.createElement(import_dsh_client_ui_primitives.Button, { variant: "ghost", onClick: onClose }, t("action.cancel")), /* @__PURE__ */ React2.createElement(import_dsh_client_ui_primitives.Button, { variant: "primary", disabled: busy, onClick: go, style: danger ? { background: "var(--dsw-alias-state-error-primary)" } : void 0 }, confirmLabel))
    },
    /* @__PURE__ */ React2.createElement("p", { style: { margin: 0, color: "var(--dsw-alias-label-secondary)", fontSize: 13.5, lineHeight: "21px" } }, body),
    error && /* @__PURE__ */ React2.createElement("div", { className: "envx-result", "data-ok": "false", style: { marginTop: 12 } }, /* @__PURE__ */ React2.createElement("span", null, error))
  );
}

// src/client/browser.jsx
var React3 = __toESM(require("react"), 1);
var import_react3 = require("react");
var import_dsh_client_ui_primitives2 = require("@deepseek-ai/dsh-client-ui-primitives");
function formatSize(n) {
  if (n === void 0 || n === null) return "";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}
function baseName(p) {
  const parts = String(p).split(/[\\/]+/).filter(Boolean);
  return parts[parts.length - 1] ?? p;
}
function RemoteBrowser({ open, mode = "workspace", environments, initialEnvId, initialPath, onClose, onPicked, onCreated, t }) {
  const [envId, setEnvId] = (0, import_react3.useState)(initialEnvId);
  const [listing, setListing] = (0, import_react3.useState)(void 0);
  const [loading, setLoading] = (0, import_react3.useState)(false);
  const [error, setError] = (0, import_react3.useState)(void 0);
  const [pathText, setPathText] = (0, import_react3.useState)("");
  const [title, setTitle] = (0, import_react3.useState)("");
  const [titleTouched, setTitleTouched] = (0, import_react3.useState)(false);
  const [busy, setBusy] = (0, import_react3.useState)(false);
  const [newFolder, setNewFolder] = (0, import_react3.useState)(void 0);
  const seq = (0, import_react3.useRef)(0);
  const load = (0, import_react3.useCallback)(async (id, path) => {
    if (!id) return;
    const mine = ++seq.current;
    setLoading(true);
    setError(void 0);
    try {
      const value = await call("fs.list", { envId: id, path });
      if (mine !== seq.current) return;
      setListing(value);
      setPathText(value.path);
    } catch (e) {
      if (mine !== seq.current) return;
      setError(e.message);
    } finally {
      if (mine === seq.current) setLoading(false);
    }
  }, []);
  (0, import_react3.useEffect)(() => {
    if (!open) return;
    const id = initialEnvId ?? environments[0]?.id;
    setEnvId(id);
    setListing(void 0);
    setTitle("");
    setTitleTouched(false);
    setNewFolder(void 0);
    load(id, initialPath);
  }, [open, initialEnvId, initialPath]);
  const env = environments.find((e) => e.id === envId);
  const current = listing?.path;
  const derivedTitle = current && env ? `${baseName(current)} @ ${env.name}` : "";
  const effectiveTitle = titleTouched ? title : derivedTitle;
  const changeEnv = (id) => {
    setEnvId(id);
    setListing(void 0);
    load(id, void 0);
  };
  const join = (name) => {
    const sep = listing?.sep ?? "/";
    return current.endsWith(sep) ? `${current}${name}` : `${current}${sep}${name}`;
  };
  const createFolder = async () => {
    const name = (newFolder ?? "").trim();
    if (!name) return setNewFolder(void 0);
    try {
      await call("fs.mkdir", { envId, path: join(name) });
      setNewFolder(void 0);
      load(envId, join(name));
    } catch (e) {
      setError(e.message);
    }
  };
  const confirm = async (startSession) => {
    if (!current) return;
    if (mode === "pick") {
      onPicked?.({ envId, path: current });
      return;
    }
    setBusy(true);
    setError(void 0);
    try {
      const value = await call("remoteWorkspace.create", { envId, root: current, title: effectiveTitle });
      invalidate();
      onCreated?.(value, startSession);
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };
  const dirs = (listing?.entries ?? []).filter((e) => e.type === "dir");
  const files = (listing?.entries ?? []).filter((e) => e.type !== "dir");
  const footer = /* @__PURE__ */ React3.createElement("div", { className: "envx-footer" }, mode === "workspace" && /* @__PURE__ */ React3.createElement(
    "input",
    {
      className: "envx-input",
      style: { flex: 1, minWidth: 0 },
      value: effectiveTitle,
      placeholder: t("browser.workspaceName"),
      "aria-label": t("browser.workspaceName"),
      onChange: (e) => {
        setTitle(e.target.value);
        setTitleTouched(true);
      }
    }
  ), mode !== "workspace" && /* @__PURE__ */ React3.createElement("span", { className: "envx-spacer" }), /* @__PURE__ */ React3.createElement(import_dsh_client_ui_primitives2.Button, { variant: "ghost", onClick: onClose }, t("action.cancel")), mode === "workspace" && /* @__PURE__ */ React3.createElement(import_dsh_client_ui_primitives2.Button, { variant: "outline", disabled: !current || busy, onClick: () => confirm(false) }, t("browser.create")), /* @__PURE__ */ React3.createElement(import_dsh_client_ui_primitives2.Button, { variant: "primary", disabled: !current || busy, onClick: () => confirm(true) }, mode === "workspace" ? t("browser.createAndOpen") : t("action.choose")));
  return /* @__PURE__ */ React3.createElement(import_dsh_client_ui_primitives2.Modal, { open, onClose, title: mode === "workspace" ? t("browser.title.workspace") : t("browser.title"), closeLabel: t("action.close"), footer, className: "envx-dialog-wide" }, /* @__PURE__ */ React3.createElement("div", { className: "envx-browser" }, /* @__PURE__ */ React3.createElement("div", { className: "envx-browser-bar" }, /* @__PURE__ */ React3.createElement("select", { className: "envx-input", value: envId ?? "", "aria-label": t("browser.env"), onChange: (e) => changeEnv(e.target.value) }, environments.map((e) => /* @__PURE__ */ React3.createElement("option", { key: e.id, value: e.id }, e.name))), /* @__PURE__ */ React3.createElement("div", { className: "envx-crumbs" }, /* @__PURE__ */ React3.createElement(
    "input",
    {
      value: pathText,
      "aria-label": t("browser.path"),
      spellCheck: false,
      onChange: (e) => setPathText(e.target.value),
      onKeyDown: (e) => {
        if (e.key === "Enter") load(envId, pathText.trim() || void 0);
      }
    }
  )), /* @__PURE__ */ React3.createElement("button", { type: "button", className: "envx-iconbtn", title: t("action.up"), "aria-label": t("action.up"), disabled: !listing?.parent, onClick: () => load(envId, listing.parent) }, /* @__PURE__ */ React3.createElement(IconUp, { size: 16 })), /* @__PURE__ */ React3.createElement("button", { type: "button", className: "envx-iconbtn", title: t("action.home"), "aria-label": t("action.home"), disabled: !listing?.home, onClick: () => load(envId, listing.home) }, /* @__PURE__ */ React3.createElement(IconHome, { size: 16 })), /* @__PURE__ */ React3.createElement("button", { type: "button", className: "envx-iconbtn", title: t("action.newFolder"), "aria-label": t("action.newFolder"), disabled: !current, onClick: () => setNewFolder("") }, /* @__PURE__ */ React3.createElement(IconPlus, { size: 16 })), /* @__PURE__ */ React3.createElement("button", { type: "button", className: "envx-iconbtn", title: t("action.refresh"), "aria-label": t("action.refresh"), onClick: () => load(envId, current) }, /* @__PURE__ */ React3.createElement(IconRefresh, { size: 16 }))), /* @__PURE__ */ React3.createElement("div", { className: "envx-browser-list", role: "list" }, loading && !listing && /* @__PURE__ */ React3.createElement("div", { className: "envx-browser-state" }, /* @__PURE__ */ React3.createElement(IconSpinner, { size: 16 }), t("browser.loading")), error && /* @__PURE__ */ React3.createElement("div", { className: "envx-browser-state", style: { color: "var(--dsw-alias-state-error-primary)", flexDirection: "column" } }, /* @__PURE__ */ React3.createElement("span", null, error), /* @__PURE__ */ React3.createElement("button", { type: "button", className: "envx-textbtn", onClick: () => load(envId, listing?.path) }, t("action.retry"))), !error && listing && /* @__PURE__ */ React3.createElement(React3.Fragment, null, newFolder !== void 0 && /* @__PURE__ */ React3.createElement("div", { className: "envx-entry", "data-type": "dir" }, /* @__PURE__ */ React3.createElement(IconFolder, { size: 16 }), /* @__PURE__ */ React3.createElement(
    "input",
    {
      className: "envx-input",
      style: { height: 26 },
      autoFocus: true,
      value: newFolder,
      placeholder: t("browser.folderName"),
      onChange: (e) => setNewFolder(e.target.value),
      onKeyDown: (e) => {
        if (e.key === "Enter") createFolder();
        if (e.key === "Escape") {
          e.stopPropagation();
          setNewFolder(void 0);
        }
      },
      onBlur: createFolder
    }
  )), dirs.map((e) => /* @__PURE__ */ React3.createElement("button", { type: "button", key: `d:${e.name}`, className: "envx-entry", "data-type": "dir", onClick: () => load(envId, join(e.name)) }, /* @__PURE__ */ React3.createElement(IconFolder, { size: 16 }), /* @__PURE__ */ React3.createElement("span", null, e.name))), files.map((e) => /* @__PURE__ */ React3.createElement("div", { key: `f:${e.name}`, className: "envx-entry", "data-type": "file" }, /* @__PURE__ */ React3.createElement(IconFile, { size: 16 }), /* @__PURE__ */ React3.createElement("span", null, e.name), /* @__PURE__ */ React3.createElement("em", null, formatSize(e.size)))), dirs.length === 0 && files.length === 0 && newFolder === void 0 && /* @__PURE__ */ React3.createElement("div", { className: "envx-browser-state" }, t("browser.empty"))))));
}

// src/client/page.jsx
function relativeTime(t, ms) {
  const d = Date.now() - ms;
  if (d < 6e4) return t("time.justNow");
  if (d < 36e5) return t("time.minutes", { n: Math.floor(d / 6e4) });
  return t("time.hours", { n: Math.floor(d / 36e5) });
}
function target(env) {
  const c = env.config ?? {};
  switch (env.kind) {
    case "server":
      return `${c.host}:${c.port}`;
    case "ssh":
      return `${c.username ? `${c.username}@` : ""}${c.host}${c.port && Number(c.port) !== 22 ? `:${c.port}` : ""}`;
    case "adb":
      return c.serial;
    case "winuser":
      return c.account;
    default:
      return env.description;
  }
}
function statusOf(env, t) {
  const st = env.status ?? {};
  if (st.busy) {
    const who = st.holders?.[0]?.title;
    const queue = st.queue?.length ? ` \xB7 ${t("status.queue", { count: st.queue.length })}` : "";
    return { state: "busy", text: (who ? t("status.busyBy", { who }) : t("status.busy")) + queue };
  }
  if (env.lastError) return { state: "error", text: t("status.failed"), detail: env.lastError };
  if (env.info || env.kind === "local" || env.discovered) return { state: "ok", text: t("status.available") };
  return { state: "idle", text: t("status.unknown") };
}
function EnvCard({ env, t, onEdit, onDelete, onWorkspace }) {
  const test = useAction();
  const status = statusOf(env, t);
  const sub = [t(`kind.${env.kind}`), target(env)].filter(Boolean).join(" \xB7 ");
  const info = env.info;
  return /* @__PURE__ */ React4.createElement("article", { className: "envx-card", "data-kind": env.kind }, /* @__PURE__ */ React4.createElement("div", { className: "envx-card-head" }, /* @__PURE__ */ React4.createElement("span", { className: "envx-tile", "data-kind": env.kind }, /* @__PURE__ */ React4.createElement(KindIcon, { kind: env.kind })), /* @__PURE__ */ React4.createElement("div", { className: "envx-card-title" }, /* @__PURE__ */ React4.createElement("strong", { title: env.name }, env.name), /* @__PURE__ */ React4.createElement("span", { className: "envx-sub", title: sub }, sub)), /* @__PURE__ */ React4.createElement("span", { className: "envx-status", "data-state": status.state, title: status.detail ?? status.text }, /* @__PURE__ */ React4.createElement("i", null), status.text)), /* @__PURE__ */ React4.createElement("div", { className: "envx-meta" }, /* @__PURE__ */ React4.createElement("span", { className: "envx-chip" }, /* @__PURE__ */ React4.createElement("code", null, env.alias)), info && /* @__PURE__ */ React4.createElement("span", { className: "envx-chip" }, t("info.os", { os: info.os, arch: info.arch || "\u2014" })), info?.user && /* @__PURE__ */ React4.createElement("span", { className: "envx-chip" }, info.user), /* @__PURE__ */ React4.createElement("span", { className: "envx-chip" }, env.exclusive ? t("status.exclusive") : t("status.shared")), env.discovered && /* @__PURE__ */ React4.createElement("span", { className: "envx-chip", "data-tone": "accent" }, t("status.discovered")), env.builtin && /* @__PURE__ */ React4.createElement("span", { className: "envx-chip" }, t("status.builtin"))), (test.error || status.state === "error" && status.detail) && /* @__PURE__ */ React4.createElement("div", { className: "envx-error-line" }, test.error ?? status.detail), /* @__PURE__ */ React4.createElement("div", { className: "envx-card-foot" }, /* @__PURE__ */ React4.createElement("button", { type: "button", className: "envx-linkbtn", onClick: () => onWorkspace(env) }, /* @__PURE__ */ React4.createElement(IconFolder, { size: 14 }), t("action.newWorkspace")), /* @__PURE__ */ React4.createElement("button", { type: "button", className: "envx-linkbtn", disabled: test.busy, onClick: () => test.run(async () => {
    const r = await call("test", { id: env.id });
    if (!r.ok) throw new Error(r.error);
  }) }, test.busy ? /* @__PURE__ */ React4.createElement(IconSpinner, { size: 14 }) : /* @__PURE__ */ React4.createElement(IconPlug, { size: 14 }), test.busy ? t("action.testing") : t("action.test")), /* @__PURE__ */ React4.createElement("span", { className: "envx-spacer" }), env.discovered && /* @__PURE__ */ React4.createElement(import_dsh_client_ui_primitives3.Tooltip, { label: t("action.addDevice"), side: "top" }, /* @__PURE__ */ React4.createElement("button", { type: "button", className: "envx-iconbtn", "aria-label": t("action.addDevice"), onClick: () => call("save", { environment: { id: env.id, name: env.name, kind: "adb", config: env.config, description: env.description } }).then(invalidate) }, /* @__PURE__ */ React4.createElement(IconPlus, { size: 16 }))), !env.builtin && !env.discovered && /* @__PURE__ */ React4.createElement(React4.Fragment, null, /* @__PURE__ */ React4.createElement(import_dsh_client_ui_primitives3.Tooltip, { label: t("action.edit"), side: "top" }, /* @__PURE__ */ React4.createElement("button", { type: "button", className: "envx-iconbtn", "aria-label": t("action.edit"), onClick: () => onEdit(env) }, /* @__PURE__ */ React4.createElement(IconEdit, { size: 16 }))), /* @__PURE__ */ React4.createElement(import_dsh_client_ui_primitives3.Tooltip, { label: t("action.delete"), side: "top" }, /* @__PURE__ */ React4.createElement("button", { type: "button", className: "envx-iconbtn", "data-danger": "", "aria-label": t("action.delete"), onClick: () => onDelete(env) }, /* @__PURE__ */ React4.createElement(IconTrash, { size: 16 }))))));
}
function EnvironmentsPage({ t, startSession }) {
  const { data, error, loading, refresh } = useEnvState(void 0, { discover: true });
  const [dialog, setDialog] = (0, import_react4.useState)(void 0);
  const refreshing = useAction();
  const envs = data?.environments ?? [];
  const byId = Object.fromEntries(envs.map((e) => [e.id, e]));
  const workspaces = data?.remoteWorkspaces ?? [];
  const leases = data?.leases ?? [];
  const onCreated = (value, start) => {
    setDialog(void 0);
    if (start && value.workspaceId) startSession(value.workspaceId);
  };
  return /* @__PURE__ */ React4.createElement("div", { className: "envx-page" }, /* @__PURE__ */ React4.createElement("div", { className: "envx-scroll" }, /* @__PURE__ */ React4.createElement("div", { className: "envx-content" }, /* @__PURE__ */ React4.createElement("header", { className: "envx-heading" }, /* @__PURE__ */ React4.createElement("div", null, /* @__PURE__ */ React4.createElement("h1", null, t("page.title")), /* @__PURE__ */ React4.createElement("p", null, t("page.subtitle"))), /* @__PURE__ */ React4.createElement("div", { className: "envx-actions" }, /* @__PURE__ */ React4.createElement(import_dsh_client_ui_primitives3.Tooltip, { label: t("action.refresh"), side: "bottom" }, /* @__PURE__ */ React4.createElement("button", { type: "button", className: "envx-iconbtn", "aria-label": t("action.refresh"), onClick: () => refreshing.run(async () => {
    await call("state", { discover: true });
    refresh();
  }) }, refreshing.busy || loading && !data ? /* @__PURE__ */ React4.createElement(IconSpinner, { size: 16 }) : /* @__PURE__ */ React4.createElement(IconRefresh, { size: 16 }))), /* @__PURE__ */ React4.createElement(import_dsh_client_ui_primitives3.Button, { variant: "primary", icon: /* @__PURE__ */ React4.createElement(IconPlus, { size: 16 }), onClick: () => setDialog({ type: "env" }) }, t("action.add")))), error && /* @__PURE__ */ React4.createElement("div", { className: "envx-banner" }, t("err.generic", { message: error })), data?.discovered?.adbError && envs.some((e) => e.kind === "adb") && /* @__PURE__ */ React4.createElement("div", { className: "envx-banner", "data-tone": "info" }, t("adb.error", { message: data.discovered.adbError })), /* @__PURE__ */ React4.createElement("section", { className: "envx-section" }, /* @__PURE__ */ React4.createElement("div", { className: "envx-section-head" }, /* @__PURE__ */ React4.createElement("h2", null, t("section.environments"), /* @__PURE__ */ React4.createElement("span", { className: "envx-count" }, envs.length))), /* @__PURE__ */ React4.createElement("div", { className: "envx-grid" }, envs.map((env) => /* @__PURE__ */ React4.createElement(
    EnvCard,
    {
      key: env.id,
      env,
      t,
      onEdit: (e) => setDialog({ type: "env", environment: e }),
      onDelete: (e) => setDialog({ type: "delete", environment: e }),
      onWorkspace: (e) => setDialog({ type: "browser", envId: e.id })
    }
  )), /* @__PURE__ */ React4.createElement("button", { type: "button", className: "envx-card envx-kind", "data-dashed": "", style: { alignItems: "center", justifyContent: "center", minHeight: 132, flexDirection: "column", gap: 6, color: "var(--dsw-alias-label-tertiary)" }, onClick: () => setDialog({ type: "env" }) }, /* @__PURE__ */ React4.createElement(IconPlus, { size: 20 }), /* @__PURE__ */ React4.createElement("span", { style: { fontSize: 13 } }, t("action.add"))))), /* @__PURE__ */ React4.createElement("section", { className: "envx-section" }, /* @__PURE__ */ React4.createElement("div", { className: "envx-section-head" }, /* @__PURE__ */ React4.createElement("div", null, /* @__PURE__ */ React4.createElement("h2", null, t("section.workspaces"), /* @__PURE__ */ React4.createElement("span", { className: "envx-count" }, workspaces.length)), /* @__PURE__ */ React4.createElement("p", null, t("section.workspaces.hint"))), /* @__PURE__ */ React4.createElement("button", { type: "button", className: "envx-linkbtn", onClick: () => setDialog({ type: "browser" }) }, /* @__PURE__ */ React4.createElement(IconPlus, { size: 14 }), t("action.newWorkspace"))), workspaces.length === 0 ? /* @__PURE__ */ React4.createElement("div", { className: "envx-empty" }, t("section.workspaces.empty")) : /* @__PURE__ */ React4.createElement("div", { className: "envx-list" }, workspaces.map((ws) => {
    const env = byId[ws.envId];
    return /* @__PURE__ */ React4.createElement("div", { className: "envx-row", key: ws.id, "data-kind": env?.kind ?? "server" }, /* @__PURE__ */ React4.createElement("span", { className: "envx-tile", "data-kind": env?.kind ?? "server" }, /* @__PURE__ */ React4.createElement(IconFolder, { size: 18 })), /* @__PURE__ */ React4.createElement("div", { className: "envx-row-main" }, /* @__PURE__ */ React4.createElement("strong", null, ws.title), /* @__PURE__ */ React4.createElement("span", { title: ws.root }, t("ws.root", { env: env?.name ?? ws.envId, root: ws.root }))), ws.workspaceId && /* @__PURE__ */ React4.createElement("button", { type: "button", className: "envx-linkbtn", onClick: () => startSession(ws.workspaceId) }, t("action.newSession")), /* @__PURE__ */ React4.createElement(import_dsh_client_ui_primitives3.Tooltip, { label: t("action.remove"), side: "top" }, /* @__PURE__ */ React4.createElement("button", { type: "button", className: "envx-iconbtn", "data-danger": "", "aria-label": t("action.remove"), onClick: () => call("remoteWorkspace.delete", { id: ws.id }).then(invalidate) }, /* @__PURE__ */ React4.createElement(IconTrash, { size: 16 }))));
  }))), /* @__PURE__ */ React4.createElement("section", { className: "envx-section" }, /* @__PURE__ */ React4.createElement("div", { className: "envx-section-head" }, /* @__PURE__ */ React4.createElement("h2", null, t("section.leases"), /* @__PURE__ */ React4.createElement("span", { className: "envx-count" }, leases.length))), leases.length === 0 ? /* @__PURE__ */ React4.createElement("div", { className: "envx-empty" }, t("section.leases.empty")) : /* @__PURE__ */ React4.createElement("div", { className: "envx-list" }, leases.map((l) => {
    const env = byId[l.envId];
    return /* @__PURE__ */ React4.createElement("div", { className: "envx-row", key: l.id, "data-kind": env?.kind ?? "server" }, /* @__PURE__ */ React4.createElement("span", { className: "envx-tile", "data-kind": env?.kind ?? "server" }, /* @__PURE__ */ React4.createElement(KindIcon, { kind: env?.kind, size: 18 })), /* @__PURE__ */ React4.createElement("div", { className: "envx-row-main" }, /* @__PURE__ */ React4.createElement("strong", null, l.name), /* @__PURE__ */ React4.createElement("span", null, t("lease.session", { id: String(l.owner?.sessionId ?? "").replace(/^session-/, "").slice(0, 8) }), " \xB7 ", relativeTime(t, l.createdAt), l.owner?.reason ? ` \xB7 ${l.owner.reason}` : "", l.tunnels?.length ? ` \xB7 ${t("lease.tunnels", { count: l.tunnels.length })}` : "")), /* @__PURE__ */ React4.createElement("span", { className: "envx-chip", "data-tone": l.purpose === "mount" ? "accent" : void 0 }, l.purpose === "mount" ? t("badge.mount") : t("badge.borrow")), /* @__PURE__ */ React4.createElement("button", { type: "button", className: "envx-linkbtn", onClick: () => call("lease.release", { leaseId: l.id }).then(invalidate) }, t("action.release")));
  }))))), /* @__PURE__ */ React4.createElement(EnvDialog, { open: dialog?.type === "env", environment: dialog?.environment, platform: data?.platform, onClose: () => setDialog(void 0), t }), /* @__PURE__ */ React4.createElement(
    ConfirmDialog,
    {
      open: dialog?.type === "delete",
      title: t("dialog.delete.title"),
      body: dialog?.environment?.kind === "winuser" ? t("dialog.account.delete", { name: dialog?.environment?.config?.account }) : t("dialog.delete.body", { name: dialog?.environment?.name ?? "" }),
      confirmLabel: t("action.delete"),
      danger: true,
      onConfirm: () => dialog.environment.kind === "winuser" ? call("winuser.delete", { name: dialog.environment.config.account }) : call("delete", { id: dialog.environment.id }),
      onClose: () => setDialog(void 0),
      t
    }
  ), /* @__PURE__ */ React4.createElement(
    RemoteBrowser,
    {
      open: dialog?.type === "browser",
      mode: "workspace",
      environments: envs,
      initialEnvId: dialog?.envId,
      onClose: () => setDialog(void 0),
      onCreated,
      t
    }
  ));
}

// src/client/chip.jsx
var React5 = __toESM(require("react"), 1);
var import_react5 = require("react");
var import_react_dom = require("react-dom");
function Popover({ anchor, onClose, children }) {
  const ref = (0, import_react5.useRef)(null);
  const [pos, setPos] = (0, import_react5.useState)(void 0);
  (0, import_react5.useLayoutEffect)(() => {
    const place = () => {
      const r = anchor.getBoundingClientRect();
      const el = ref.current;
      const h = el?.offsetHeight ?? 320;
      const w = el?.offsetWidth ?? 340;
      const above = r.top - 8 - h >= 8;
      const top = above ? r.top - 8 - h : Math.min(window.innerHeight - h - 8, r.bottom + 8);
      const left = Math.max(8, Math.min(window.innerWidth - w - 8, r.left));
      setPos({ top: Math.max(8, top), left });
    };
    place();
    const obs = new ResizeObserver(place);
    if (ref.current) obs.observe(ref.current);
    window.addEventListener("resize", place);
    return () => {
      obs.disconnect();
      window.removeEventListener("resize", place);
    };
  }, [anchor]);
  (0, import_react5.useEffect)(() => {
    const onDown = (e) => {
      if (ref.current?.contains(e.target) || anchor.contains(e.target)) return;
      if (e.target.closest?.("[role=dialog],[data-envx-keep]")) return;
      onClose();
    };
    const onKey = (e) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("pointerdown", onDown, true);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown, true);
      document.removeEventListener("keydown", onKey);
    };
  }, [anchor, onClose]);
  return (0, import_react_dom.createPortal)(
    /* @__PURE__ */ React5.createElement("div", { ref, className: "envx-pop", role: "dialog", style: pos ? { top: pos.top, left: pos.left } : { visibility: "hidden", top: 0, left: 0 } }, children),
    document.body
  );
}
function Panel({ sessionId, data, t, openManager, onClose }) {
  const [browser, setBrowser] = (0, import_react5.useState)(false);
  const act = useAction();
  const [savedNote, setSavedNote] = (0, import_react5.useState)(false);
  const envs = data.environments ?? [];
  const byId = Object.fromEntries(envs.map((e) => [e.id, e]));
  const s = data.session ?? {};
  const mountEnv = s.mount ? byId[s.mount.envId] : void 0;
  const locked = !!s.started;
  const borrowable = new Set(s.borrowable ?? []);
  const candidates = envs.filter((e) => e.borrowable !== false);
  const toggle = (id) => {
    const next = new Set(borrowable);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    act.run(() => call("session.set", { sessionId, borrowable: [...next], cwd: s.cwd }));
  };
  const sourceLabel = s.borrowableSource === "session" ? t("pop.borrow.custom") : s.borrowableSource === "workspace" ? t("pop.borrow.inherit.workspace") : t("pop.borrow.inherit.all");
  return /* @__PURE__ */ React5.createElement(React5.Fragment, null, /* @__PURE__ */ React5.createElement("div", { className: "envx-pop-section" }, /* @__PURE__ */ React5.createElement("div", { className: "envx-pop-title" }, /* @__PURE__ */ React5.createElement("span", null, t("pop.mount")), s.mount?.source === "workspace" && /* @__PURE__ */ React5.createElement("small", null, t("pop.mount.fromWorkspace"))), s.mount ? /* @__PURE__ */ React5.createElement("div", { className: "envx-mounted", "data-kind": mountEnv?.kind ?? "server" }, /* @__PURE__ */ React5.createElement("span", { className: "envx-tile", "data-kind": mountEnv?.kind ?? "server", style: { width: 30, height: 30, borderRadius: 8 } }, /* @__PURE__ */ React5.createElement(KindIcon, { kind: mountEnv?.kind, size: 17 })), /* @__PURE__ */ React5.createElement("div", { className: "envx-pop-item-main" }, /* @__PURE__ */ React5.createElement("strong", null, mountEnv?.name ?? s.mount.envId), /* @__PURE__ */ React5.createElement("span", { title: s.mountActive?.remoteRoot ?? s.mount.remoteRoot }, s.mountActive?.remoteRoot ?? s.mount.remoteRoot ?? "", !s.mountActive && !s.mountError ? ` \xB7 ${t("pop.mount.pending")}` : "")), !locked && s.mount.source === "session" && /* @__PURE__ */ React5.createElement("button", { type: "button", className: "envx-textbtn", "data-quiet": "", disabled: act.busy, onClick: () => act.run(() => call("session.set", { sessionId, mount: null })) }, t("action.unmount"))) : /* @__PURE__ */ React5.createElement(React5.Fragment, null, /* @__PURE__ */ React5.createElement("p", { className: "envx-pop-hint" }, locked ? t("pop.mount.locked") : t("pop.mount.hint")), /* @__PURE__ */ React5.createElement("div", { className: "envx-pop-item" }, /* @__PURE__ */ React5.createElement("span", { className: "envx-tile", "data-kind": "local" }, /* @__PURE__ */ React5.createElement(KindIcon, { kind: "local", size: 15 })), /* @__PURE__ */ React5.createElement("div", { className: "envx-pop-item-main" }, /* @__PURE__ */ React5.createElement("strong", null, t("pop.mount.none")))), !locked && /* @__PURE__ */ React5.createElement("div", { className: "envx-pop-foot" }, /* @__PURE__ */ React5.createElement("button", { type: "button", className: "envx-textbtn", onClick: () => setBrowser(true) }, /* @__PURE__ */ React5.createElement(IconMount, { size: 13 }), " ", t("pop.mount.pick")))), s.mountError && /* @__PURE__ */ React5.createElement("div", { className: "envx-error-line", style: { marginTop: 6 } }, t("pop.mount.error", { message: s.mountError }))), /* @__PURE__ */ React5.createElement("div", { className: "envx-pop-section" }, /* @__PURE__ */ React5.createElement("div", { className: "envx-pop-title" }, /* @__PURE__ */ React5.createElement("span", null, t("pop.borrow")), /* @__PURE__ */ React5.createElement("small", null, sourceLabel)), /* @__PURE__ */ React5.createElement("p", { className: "envx-pop-hint" }, t("pop.borrow.hint")), candidates.map((env) => {
    const held = (s.held ?? []).find((h) => h.envId === env.id);
    const busyElsewhere = env.status?.busy && !held;
    return /* @__PURE__ */ React5.createElement(
      "div",
      {
        key: env.id,
        className: "envx-pop-item",
        "data-click": "",
        "data-kind": env.kind,
        role: "checkbox",
        "aria-checked": borrowable.has(env.id),
        tabIndex: 0,
        onClick: () => toggle(env.id),
        onKeyDown: (e) => {
          if (e.key === " " || e.key === "Enter") {
            e.preventDefault();
            toggle(env.id);
          }
        }
      },
      /* @__PURE__ */ React5.createElement("span", { className: "envx-check", "data-on": borrowable.has(env.id) ? "" : void 0 }, /* @__PURE__ */ React5.createElement(IconCheck, { size: 12 })),
      /* @__PURE__ */ React5.createElement("span", { className: "envx-tile", "data-kind": env.kind }, /* @__PURE__ */ React5.createElement(KindIcon, { kind: env.kind, size: 15 })),
      /* @__PURE__ */ React5.createElement("div", { className: "envx-pop-item-main" }, /* @__PURE__ */ React5.createElement("strong", null, env.name), /* @__PURE__ */ React5.createElement("span", null, held ? `${t("badge.borrow")} \xB7 ${held.alias}` : busyElsewhere ? t("status.busy") : `${t(`kind.${env.kind}`)}${env.description && env.description !== env.name ? ` \xB7 ${env.description}` : ""}`)),
      held && /* @__PURE__ */ React5.createElement("button", { type: "button", className: "envx-textbtn", onClick: (e) => {
        e.stopPropagation();
        act.run(() => call("lease.release", { leaseId: held.id }));
      } }, t("action.return"))
    );
  }), /* @__PURE__ */ React5.createElement("div", { className: "envx-pop-foot" }, s.borrowableSource === "session" && /* @__PURE__ */ React5.createElement("button", { type: "button", className: "envx-textbtn", "data-quiet": "", onClick: () => act.run(() => call("session.set", { sessionId, borrowable: null })) }, t("pop.borrow.reset")), s.cwd && s.borrowableSource === "session" && /* @__PURE__ */ React5.createElement("button", { type: "button", className: "envx-textbtn", "data-quiet": "", onClick: () => act.run(async () => {
    await call("workspace.set", { workspacePath: s.cwd, borrowable: [...borrowable] });
    setSavedNote(true);
    setTimeout(() => setSavedNote(false), 2e3);
  }) }, savedNote ? t("pop.borrow.saved") : t("pop.borrow.saveWorkspace")), /* @__PURE__ */ React5.createElement("span", { style: { flex: 1 } }), /* @__PURE__ */ React5.createElement("button", { type: "button", className: "envx-textbtn", onClick: () => {
    onClose();
    openManager();
  } }, t("action.manage"))), act.error && /* @__PURE__ */ React5.createElement("div", { className: "envx-error-line", style: { marginTop: 6 } }, act.error)), /* @__PURE__ */ React5.createElement(
    RemoteBrowser,
    {
      open: browser,
      mode: "pick",
      environments: envs,
      onClose: () => setBrowser(false),
      onPicked: ({ envId, path }) => {
        setBrowser(false);
        act.run(() => call("session.set", { sessionId, mount: { envId, remoteRoot: path }, cwd: s.cwd }));
      },
      t
    }
  ));
}
function EnvironmentChip({ sessionId, t, openManager }) {
  const [open, setOpen] = (0, import_react5.useState)(false);
  const anchor = (0, import_react5.useRef)(null);
  const { data } = useEnvState(sessionId, { intervalMs: open ? 2500 : 8e3 });
  const s = data?.session;
  const mountEnv = s?.mount ? data.environments.find((e) => e.id === s.mount.envId) : void 0;
  const heldCount = s?.held?.length ?? 0;
  const label = s?.mount ? mountEnv?.name ?? s.mount.envId : t("chip.label");
  const title = s?.mount ? t("chip.mounted", { name: mountEnv?.name ?? s.mount.envId }) : heldCount ? t("chip.borrowed", { count: heldCount }) : t("chip.label");
  (0, import_react5.useEffect)(() => {
    if (open) invalidate();
  }, [open]);
  return /* @__PURE__ */ React5.createElement(React5.Fragment, null, /* @__PURE__ */ React5.createElement("button", { ref: anchor, type: "button", className: "envx-chipbtn", "data-active": s?.mount ? "" : void 0, "aria-expanded": open, "aria-haspopup": "dialog", title, onClick: () => setOpen((v) => !v) }, s?.mount ? /* @__PURE__ */ React5.createElement(KindIcon, { kind: mountEnv?.kind ?? "server", size: 16 }) : /* @__PURE__ */ React5.createElement(IconEnvironments, { size: 16 }), /* @__PURE__ */ React5.createElement("span", null, label), heldCount > 0 && /* @__PURE__ */ React5.createElement("b", null, heldCount)), open && anchor.current && /* @__PURE__ */ React5.createElement(Popover, { anchor: anchor.current, onClose: () => setOpen(false) }, data ? /* @__PURE__ */ React5.createElement(Panel, { sessionId, data, t, openManager, onClose: () => setOpen(false) }) : /* @__PURE__ */ React5.createElement("div", { className: "envx-pop-section" }, /* @__PURE__ */ React5.createElement(IconSpinner, { size: 16 }))));
}

// src/client/index.jsx
var PANEL_ID = "environments";
var inject = ["slots", "locale", "layout", "uiWorkspace"];
function apply(ctx) {
  ctx.effect(() => ctx.locale.register(NS, dictionaries), "environments: dictionaries");
  const t = ctx.locale.bind(NS);
  const subscribeLocale = (listener) => ctx.locale.subscribe(listener);
  const localeSnapshot = () => ctx.locale.getSnapshot();
  ctx.effect(() => {
    if (typeof document === "undefined") return () => {
    };
    const style = document.createElement("style");
    style.dataset.plugin = "dsh-plugin-environments";
    style.textContent = styles_default;
    document.head.appendChild(style);
    return () => style.remove();
  }, "environments: styles");
  const openManager = () => {
    try {
      ctx.layout.selectPanel(PANEL_ID);
    } catch {
    }
  };
  const startSession = (workspaceId) => {
    try {
      ctx.uiWorkspace.startSession(workspaceId);
    } catch {
    }
  };
  function Page() {
    (0, import_react6.useSyncExternalStore)(subscribeLocale, localeSnapshot);
    return /* @__PURE__ */ React6.createElement(EnvironmentsPage, { t, startSession });
  }
  function Chip({ sessionId }) {
    (0, import_react6.useSyncExternalStore)(subscribeLocale, localeSnapshot);
    if (!sessionId) return null;
    return /* @__PURE__ */ React6.createElement(EnvironmentChip, { sessionId, t, openManager });
  }
  function PanelIcon({ size }) {
    return /* @__PURE__ */ React6.createElement(IconEnvironments, { size });
  }
  ctx.slots.inject("main", () => ctx.slots.register({
    name: "main",
    key: PANEL_ID,
    locale: NS
  }, Page));
  ctx.slots.inject("sidebar.panellist", () => ctx.slots.register({
    name: "sidebar.panellist",
    id: PANEL_ID,
    order: 30,
    locale: NS,
    label: () => t("panel")
  }, PanelIcon));
  ctx.slots.inject("conversation.input.left", () => ctx.slots.register({
    name: "conversation.input.left",
    id: "environments",
    order: 60,
    locale: NS,
    inject: (sessionId) => ({ sessionId: sessionId === void 0 ? void 0 : String(sessionId) })
  }, Chip));
}

		})(module, module.exports, require);
		const entry = module.exports;
		return { inject: entry.inject, apply: entry.apply };
	},
});
