/** Desktop dialog for enabling the iPad companion, pairing with a QR code and
 * revoking devices. Built with DOM APIs and host widgets only (no HTML strings). */
import type { PluginButtonProps, PluginDialogProps, PluginFrontendContext, PluginSettingsSchema, PluginWidgetHandle } from "learnharness-plugin-api";
import type { CompanionStatus, PairingInfo } from "./backend.ts";
import { DEFAULT_PORT } from "./constants.ts";
import type { CompanionHost } from "./host.ts";

const SVG = "http://www.w3.org/2000/svg";
/** Render QR module rows as one SVG path with a 4-module quiet zone. */
export function qrSvg(rows: readonly string[], label: string): SVGSVGElement {
  const size = rows.length + 8;
  const svg = document.createElementNS(SVG, "svg");
  svg.setAttribute("viewBox", `0 0 ${size} ${size}`); svg.setAttribute("role", "img"); svg.setAttribute("aria-label", label);
  svg.setAttribute("shape-rendering", "crispEdges"); svg.classList.add("drawing-pad-companion-qr");
  const background = document.createElementNS(SVG, "rect");
  background.setAttribute("width", String(size)); background.setAttribute("height", String(size)); background.setAttribute("fill", "#ffffff");
  let d = "";
  rows.forEach((row, y) => { for (let x = 0; x < row.length; x++) if (row[x] === "1") d += `M${x + 4} ${y + 4}h1v1h-1z`; });
  const path = document.createElementNS(SVG, "path");
  path.setAttribute("d", d); path.setAttribute("fill", "#000000");
  svg.append(background, path);
  return svg;
}
export function describeStatus(status: CompanionStatus | undefined): string {
  if (!status) return "Checking companion status…";
  if (status.error) return status.error;
  if (!status.running) return "Off. Turn it on to let a paired iPad draw into this Draw panel.";
  const connected = status.devices.filter(device => device.connected).length;
  return `On · port ${status.port} · ${connected ? `${connected} device${connected === 1 ? "" : "s"} connected` : "no device connected"}`;
}
const element = <K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};

export function openCompanionDialog(ctx: PluginFrontendContext, host: CompanionHost): PluginWidgetHandle<PluginDialogProps> {
  return ctx.ui.openDialog({
    title: "iPad drawing companion",
    content(container, signal) {
      const root = element("div", "drawing-pad-companion");
      const heading = element("h2", "drawing-pad-companion-title", "iPad drawing companion");
      const intro = element("p", "drawing-pad-companion-text",
        "Draw with Apple Pencil in Safari on an iPad on the same Wi-Fi network. Strokes appear live in this Draw panel and are " +
        "sent only with your next submission, exactly like ink drawn here. The iPad can reach only this drawing, nothing else in LearnHarness.");
      const status = element("p", "drawing-pad-companion-status"); status.setAttribute("role", "status");
      const settings = element("div");
      const pairArea = element("div", "drawing-pad-companion-pair");
      const pairButton = element("span");
      const qr = element("div", "drawing-pad-companion-qr-area");
      const devicesHeading = element("h3", "drawing-pad-companion-subtitle", "Paired devices");
      const devices = element("ul", "drawing-pad-companion-devices");
      const revokeAllTarget = element("span");
      const help = element("p", "drawing-pad-companion-help",
        "If Safari cannot connect: keep both devices on the same network, allow LearnHarness through Windows Defender Firewall " +
        "for Private networks (Windows asks the first time the companion starts), and make sure the Wi-Fi network is set to Private. " +
        "Traffic is not encrypted, so use the companion only on a network you trust.");
      pairArea.append(pairButton, qr);
      root.append(heading, intro, status, settings, pairArea, devicesHeading, devices, revokeAllTarget, help);
      container.append(root);

      let port = host.status?.port ?? DEFAULT_PORT, portEdited = false, pairing: PairingInfo | undefined, pairedBefore = 0, linkIndex = 0;
      const handles: { dispose(): void }[] = [];
      const rows = (value: CompanionStatus | undefined): PluginSettingsSchema["rows"] => [
        { key: "enabled", type: "toggle", label: "iPad companion", value: !!value?.running,
          description: "Runs a small drawing-only server on your local network while LearnHarness is open.",
          async onChange(enabled: boolean) {
            if (enabled) await host.call("companion-start", { port });
            else { pairing = undefined; await host.call("companion-stop"); }
            render();
          } },
        { key: "port", type: "number", label: "Port", value: port, min: 1024, max: 65535, step: 1,
          description: "Change only if the default port is in use.",
          validate: (next: number) => Number.isSafeInteger(next) && next >= 1024 && next <= 65535 ? undefined : "Use a port from 1024 to 65535.",
          async onChange(next: number) {
            port = next; portEdited = true;
            if (host.running) { pairing = undefined; await host.call("companion-start", { port }); }
            render();
          } },
      ];
      const settingsHandle = ctx.ui.mountSettingsRows(settings, { rows: rows(host.status) }, { signal });
      handles.push(settingsHandle);
      const pair: PluginWidgetHandle<PluginButtonProps> = ctx.ui.mountButton(pairButton, {
        label: "Show pairing QR code", variant: "default", size: "sm",
        async onClick() {
          pairedBefore = host.status?.devices.length ?? 0;
          pairing = await host.call<PairingInfo>("companion-pair"); linkIndex = 0; render();
        },
      }, { signal });
      handles.push(pair);
      const revokeAll = ctx.ui.mountButton(revokeAllTarget, {
        label: "Revoke all devices", variant: "outline", size: "sm",
        async onClick() { pairing = undefined; await host.call("companion-revoke", {}); render(); },
      }, { signal });
      handles.push(revokeAll);
      let deviceButtons: { dispose(): void }[] = [];

      function renderQr(): void {
        qr.replaceChildren();
        const value = host.status;
        // Expiry comes from the pairing call itself (status notifications may arrive later);
        // the single-use code is hidden once a new device has paired with it.
        const used = (value?.devices.length ?? 0) > pairedBefore;
        if (!pairing || !value?.running || pairing.expires <= Date.now() || used) { pairing = undefined; return; }
        if (!pairing.links.length) {
          qr.append(element("p", "drawing-pad-companion-help", "No local network address was found. Connect this computer to Wi-Fi or Ethernet."));
          return;
        }
        const link = pairing.links[Math.min(linkIndex, pairing.links.length - 1)]!;
        qr.append(qrSvg(link.qr, "Pairing QR code for the iPad companion"));
        const instructions = element("p", "drawing-pad-companion-text",
          "Scan with the iPad camera and open the link in Safari, or type this address. The code works once and expires in " +
          `${Math.max(1, Math.round((pairing.expires - Date.now()) / 60000))} min.`);
        const url = element("code", "drawing-pad-companion-url", link.url);
        qr.append(instructions, url);
        if (pairing.links.length > 1) {
          const choice = element("p", "drawing-pad-companion-help", "Not connecting? This computer has several network addresses. Try: ");
          pairing.links.forEach((other, index) => {
            const target = element("span");
            choice.append(target);
            deviceButtons.push(ctx.ui.mountButton(target, { label: other.address, variant: index === linkIndex ? "secondary" : "ghost", size: "sm",
              onClick() { linkIndex = index; render(); } }, { signal }));
          });
          qr.append(choice);
        }
      }
      function render(): void {
        if (signal.aborted) return;
        const value = host.status;
        // Follow the saved/running port unless the user changed it while the server is off.
        if (value && (value.running || !portEdited)) { port = value.port; if (value.running) portEdited = false; }
        status.textContent = describeStatus(value);
        status.dataset.state = value?.error ? "error" : value?.running ? (host.connectedDevices ? "connected" : "on") : "off";
        settingsHandle.update({ rows: rows(value) });
        pair.update({ disabled: !value?.running, label: pairing ? "Show a new pairing QR code" : "Show pairing QR code" });
        for (const handle of deviceButtons) handle.dispose();
        deviceButtons = [];
        renderQr();
        devices.replaceChildren();
        const list = value?.devices ?? [];
        if (!list.length) devices.append(element("li", "drawing-pad-companion-help", "No paired devices."));
        for (const device of list) {
          const row = element("li", "drawing-pad-companion-device");
          const name = element("span", "drawing-pad-companion-device-name", device.name);
          const state = element("span", "drawing-pad-companion-device-state",
            device.connected ? "Connected" : `Last seen ${new Date(device.lastSeen).toLocaleString()}`);
          state.dataset.connected = String(device.connected);
          const target = element("span");
          row.append(name, state, target); devices.append(row);
          deviceButtons.push(ctx.ui.mountButton(target, { label: "Revoke", variant: "outline", size: "sm",
            async onClick() { await host.call("companion-revoke", { deviceId: device.id }); render(); } }, { signal }));
        }
        revokeAll.update({ disabled: !list.length });
      }
      const off = host.onStatus(render);
      const timer = setInterval(render, 30_000);
      render();
      void host.call("companion-status").then(render, () => {});
      return () => {
        off(); clearInterval(timer);
        for (const handle of [...deviceButtons, ...handles]) handle.dispose();
        root.remove();
      };
    },
  }, { signal: ctx.signal });
}
