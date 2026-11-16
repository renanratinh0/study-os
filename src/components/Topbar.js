/**
 * Study OS V2 - Topbar Component
 * Barra superior com navegação breadcrumb dinâmica,
 * contadores de status do banco de dados e atalhos rápidos.
 */

import { escapeHtml } from "../utils/domHelpers.js";

/**
 * Atualiza os breadcrumbs na barra superior conforme a rota ativa.
 * @param {'home' | 'disciplina'} tipo
 * @param {{ semestreNome?: string, icone?: string, nome?: string }} [dados]
 */
export function atualizarBreadcrumbs(tipo, dados = {}) {
  if (typeof document === "undefined") return;
  const breadcrumbs = document.getElementById("topbar-breadcrumbs");
  if (!breadcrumbs) return;

  if (tipo === "disciplina" && dados.nome) {
    breadcrumbs.innerHTML = `
      <a href="#/" class="hover:text-notion-text transition-colors">Home</a>
      <span>/</span>
      <span class="text-notion-muted">${escapeHtml(dados.semestreNome || "Semestre")}</span>
      <span>/</span>
      <span class="text-notion-text font-semibold truncate">${dados.icone || "📘"} ${escapeHtml(dados.nome)}</span>
    `;
  } else {
    breadcrumbs.innerHTML = `<span class="text-notion-text font-semibold">🏠 Visão Geral • Database Notion</span>`;
  }
}

/**
 * Atualiza o rótulo de estatísticas compactas na barra superior.
 * @param {number} disciplinasCount
 * @param {number} pdfsSemOcrCount
 */
export function atualizarTopbarStats(disciplinasCount, pdfsSemOcrCount) {
  if (typeof document === "undefined") return;
  const topbarStats = document.getElementById("topbar-stats-label");
  if (topbarStats) {
    topbarStats.textContent = `${disciplinasCount} matérias • ${pdfsSemOcrCount} PDFs Sem OCR`;
  }
}
