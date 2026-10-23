// Install diagnostics before importing React or the WebGL scene. Dynamic imports are
// deliberate: even a module-evaluation failure is caught and shown on mobile.
const showFatalError = (kind, error, source = "") => {
  let overlay = document.getElementById("kernel-fatal-error-overlay");
  if (!overlay) {
    overlay = document.createElement("div");
    overlay.id = "kernel-fatal-error-overlay";
    Object.assign(overlay.style, {
      position: "fixed", inset: "0", zIndex: "999999",
      background: "#d00000", color: "#ffffff", padding: "20px",
      width: "100vw", height: "100vh", overflow: "auto",
      boxSizing: "border-box", font: "14px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace",
      whiteSpace: "pre-wrap", overflowWrap: "anywhere"
    });
    document.documentElement.appendChild(overlay);
  }
  const message = error?.message ?? String(error ?? "Unknown error");
  const stack = error?.stack ?? "(no JavaScript stack supplied)";
  overlay.replaceChildren();
  const heading = document.createElement("h1");
  heading.textContent = "KERNEL STARTUP / RUNTIME ERROR";
  heading.style.cssText = "font-size:22px;margin:0 0 16px;color:white";
  const details = document.createElement("pre");
  details.style.cssText = "white-space:pre-wrap;overflow-wrap:anywhere;font:inherit";
  details.textContent = kind + "\n" + message + (source ? "\n" + source : "") + "\n\nSTACK\n" + stack;
  overlay.append(heading, details);
};
window.onerror = function(message, source, lineno, colno, error) {
  showFatalError("window.onerror", error ?? new Error(String(message)), String(source || "") + ":" + lineno + ":" + colno);
  return false;
};
window.onunhandledrejection = function(event) {
  const reason = event?.reason;
  showFatalError("window.onunhandledrejection", reason instanceof Error ? reason : new Error(String(reason)));
};
window.addEventListener("error", event => {
  if (event?.target && event.target !== window) {
    showFatalError("RESOURCE LOAD ERROR", new Error("Failed to load: " + (event.target.src || event.target.href || event.target.tagName)));
  }
}, true);

(async () => {
  try {
    const [{ default: React }, { createRoot }, { default: App }, styles] = await Promise.all([
      import("react"),
      import("react-dom/client"),
      import("./ui/App.jsx"),
      import("./ui/styles.css")
    ]);
    const rootElement = document.getElementById("root");
    if (!rootElement) throw new Error("Missing #root mount element in index.html");
    createRoot(rootElement).render(React.createElement(React.StrictMode, null, React.createElement(App)));
  } catch (error) {
    showFatalError("KERNEL BOOTSTRAP FAILED", error);
    console.error("KERNEL bootstrap failed", error);
  }
})();
