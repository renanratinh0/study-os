/**
 * Study OS V2 - ImportReportModal (Lazy Loaded via Dynamic Import)
 * Modal de exibição do relatório de sincronização e importação do db.json,
 * detalhamento de semestres, disciplinas, mídias e status de OCR.
 */

import { store, calcularEstatisticasDb } from "../core/store.js";

/**
 * Abre o modal de relatório detalhado de importação e sincronização.
 * @param {string} [nomeArquivo="db.json"]
 * @param {boolean} [isManualImport=true]
 */
export function abrirModalRelatorioImportacao(nomeArquivo = "db.json", isManualImport = true) {
  if (typeof document === "undefined") return;

  const state = store.getState();
  const stats = calcularEstatisticasDb(state.db);
  const horario = new Date().toLocaleTimeString("pt-BR");
  store.setState({ ultimoRelatorioSync: { nomeArquivo, stats, horario } });

  const modal = document.getElementById("import-success-modal");
  const title = document.getElementById("import-modal-title");
  const subtitle = document.getElementById("import-modal-subtitle");
  const grid = document.getElementById("import-stats-grid");
  const breakdown = document.getElementById("import-breakdown-box");

  if (title) {
    title.textContent = isManualImport
      ? `Arquivo "${nomeArquivo}" Importado com Sucesso!`
      : `Relatório do Banco de Dados (${nomeArquivo})`;
  }

  if (subtitle) {
    subtitle.textContent = `Sincronizado às ${horario} • Exibindo somente os ${stats.pdfsSemOcr} PDFs Sem OCR nas aulas.`;
  }

  if (grid) {
    grid.innerHTML = `
      <div class="p-3 rounded-xl bg-notion-bg border border-notion-border text-center">
        <div class="text-xl font-bold text-indigo-400 font-mono">${stats.semestres}</div>
        <div class="text-[11px] text-notion-muted mt-0.5">Semestres/Cursos</div>
      </div>
      <div class="p-3 rounded-xl bg-notion-bg border border-notion-border text-center">
        <div class="text-xl font-bold text-emerald-400 font-mono">${stats.disciplinas}</div>
        <div class="text-[11px] text-notion-muted mt-0.5">Matérias & Cursos</div>
      </div>
      <div class="p-3 rounded-xl bg-notion-bg border border-notion-border text-center">
        <div class="text-xl font-bold text-amber-400 font-mono">${stats.aulas}</div>
        <div class="text-[11px] text-notion-muted mt-0.5">Aulas (${stats.aulasComNotebook} 🤖)</div>
      </div>
      <div class="p-3 rounded-xl bg-notion-bg border border-notion-border text-center">
        <div class="text-xl font-bold text-white font-mono">${stats.pdfsSemOcr}</div>
        <div class="text-[11px] text-notion-muted mt-0.5">PDFs Sem OCR</div>
      </div>
    `;
  }

  if (breakdown) {
    breakdown.innerHTML = `
      <div class="text-[11px] font-semibold text-notion-text uppercase tracking-wider mb-1">Ordem de Exibição Sob Demanda nas Aulas</div>
      <div class="flex flex-wrap gap-2">
        <span class="px-2.5 py-1 rounded-lg bg-amber-500/15 border border-amber-500/30 text-amber-300 font-mono text-[11px]">1º 📝 ${stats.porTipo.md} MD (Editável)</span>
        <span class="px-2.5 py-1 rounded-lg bg-emerald-500/15 border border-emerald-500/30 text-emerald-300 font-mono text-[11px]">2º 🖼️ ${stats.porTipo.img} Imagens</span>
        <span class="px-2.5 py-1 rounded-lg bg-rose-500/15 border border-rose-500/30 text-rose-300 font-mono text-[11px]">3º 📄 ${stats.pdfsSemOcr} PDFs (Só Sem OCR)</span>
        <span class="px-2.5 py-1 rounded-lg bg-purple-500/15 border border-purple-500/30 text-purple-300 font-mono text-[11px]">4º 🎬 ${stats.porTipo.mp4} Vídeos</span>
        <span class="px-2.5 py-1 rounded-lg bg-pink-500/15 border border-pink-500/30 text-pink-300 font-mono text-[11px]">5º 🎧 ${stats.porTipo.audio} M4A</span>
      </div>
      <div class="text-[11px] text-notion-muted pt-2 border-t border-notion-border flex items-center justify-between">
        <span>🌐 Arquivos com ID público do Google Drive:</span>
        <span class="font-mono text-emerald-400 font-semibold">${stats.arquivosComDriveId} de ${stats.arquivosTotal}</span>
      </div>
    `;
  }

  if (modal) {
    modal.classList.remove("hidden");
    modal.classList.add("flex");
  }
}

/**
 * Fecha o modal de relatório.
 */
export function fecharModalRelatorioImportacao() {
  if (typeof document === "undefined") return;
  const modal = document.getElementById("import-success-modal");
  if (modal) {
    modal.classList.add("hidden");
    modal.classList.remove("flex");
  }
}
