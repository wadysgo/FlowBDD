(() => {
  if (["localhost", "127.0.0.1", "::1"].includes(location.hostname)) return;
  document.body.classList.add("cloud-deployment");
  const note = document.querySelector(".top-note");
  if (note) note.innerHTML = "<i></i> VERCEL · GENERACIÓN DE ARTEFACTOS";
  const analyze = document.querySelector("#analyze-url");
  if (analyze) analyze.textContent = "Analizar HTML inicial";
  const observer = new MutationObserver(() => {
    const panel = document.querySelector("#visible-run-panel");
    if (panel) panel.hidden = true;
    const summary = document.querySelector(".preview-summary");
    if (summary) summary.textContent = "En Vercel se generan y validan archivos, y se analiza el HTML inicial. Para ejecutar recorridos con Chrome visible, inicia FlowBDD en tu PC.";
  });
  const results = document.querySelector("#results");
  if (results) observer.observe(results, { childList: true, subtree: true });
})();
