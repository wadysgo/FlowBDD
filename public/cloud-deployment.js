(() => {
  if (["localhost", "127.0.0.1", "::1"].includes(location.hostname)) return;
  document.body.classList.add("cloud-deployment");
  const note = document.querySelector(".top-note");
  if (note) note.innerHTML = "<i></i> VERCEL · GENERACIÓN DE ARTEFACTOS";
  const analyze = document.querySelector("#analyze-url");
  if (analyze) analyze.textContent = "Analizar HTML inicial";

  const summaryText = "En Vercel se generan y validan archivos, y se analiza el HTML inicial. Para ejecutar recorridos con Chrome visible, inicia FlowBDD en tu PC.";
  const syncCloudMode = () => {
    const panel = document.querySelector("#visible-run-panel");
    if (panel && !panel.hidden) panel.hidden = true;
    const summary = document.querySelector(".preview-summary");
    if (summary && summary.textContent !== summaryText) summary.textContent = summaryText;
  };
  const results = document.querySelector("#results");
  if (results) {
    const observer = new MutationObserver(syncCloudMode);
    observer.observe(results, { childList: true, subtree: true });
    syncCloudMode();
  }
})();
