# PiChamber

PiChamber is a set of web, desktop, and mobile surfaces for Pi Coding Agent, served by one PiChamber server that people reach from several devices.

## Places

**Server machine**:
The machine running the PiChamber server and its Pi sessions.
_Avoid_: host, backend box

**Device**:
The machine a person is using PiChamber from. It can be the server machine, or a phone or laptop reaching it over LAN, Tailscale, or a tunnel.
_Avoid_: client, frontend

**Server-local address**:
A URL that only reaches something on the server machine, such as `localhost` or `127.0.0.1` and a port.
_Avoid_: local URL (ambiguous about which machine)

## In-app browser

**PiChamber browser**:
The browser built into PiChamber's side panel.
_Avoid_: webview, iframe, preview browser

**Browser page**:
One tab in the PiChamber browser's own tab strip, under the Browser panel tab. Each page has its own address, history, and Browser route.
_Avoid_: browser tab (that is the panel tab holding the pages)

**Browser route**:
Where a browser page runs: **Server** (a Chrome on the server machine, streamed to the device, so server-local addresses work from any device) or **This device** (the device's own network, in a webview or iframe).
_Avoid_: proxy mode, proxy on/off

**Open request**:
A request, from a session or from something running on the server machine, to show the person a URL, for example a review page an extension started. It belongs to the session that asked, or to no session when that can't be determined, and is only shown live, never kept. Devices always ask before opening one.
_Avoid_: open-URL event, browser launch
