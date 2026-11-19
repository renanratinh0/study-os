/**
 * Study OS V2 - Relatório Técnico Modal (Camada 9)
 * Modal limpo carregado sob demanda (Dynamic Import) para exibir ./relatorio.md
 * formatado via markdownParser.js sem ocupar espaço no fluxo vertical da aula.
 */

import { store, buscarDisciplinaPorId } from "../core/store.js";
import { escapeHtml, mostrarToast, obterTituloAula } from "../utils/domHelpers.js";
import { obterHtmlMarkdownParseado } from "../utils/markdownParser.js";
import { resolverArtefatosAula, carregarConteudoArtefato } from "../services/mediaResolver.js";
import { hidratarConteudoAulaSobDemanda } from "../services/api.js";

function localizarAulaNoDb(lessonId, discId = "") {
  if (discId) {
    const disc = buscarDisciplinaPorId(discId);
    const aula = (disc?.aulas || []).find(a => a.id === lessonId);
    if (disc && aula) return { disc, aula };
  }

  const db = store.getState().db;
  for (const sem of (db?.semestres || [])) {
    for (const disc of (sem.disciplinas || [])) {
      const aula = (disc.aulas || []).find(a => a.id === lessonId);
      if (aula) return { disc, aula };
    }
  }

  return { disc: null, aula: null };
}

function obterOuCriarModalRelatorio() {
  if (typeof document === "undefined") return null;
  let modal = document.getElementById("modal-relatorio-tecnico");
  if (!modal) {
    modal = document.createElement("div");
    modal.id = "modal-relatorio-tecnico";
    modal.className = "fixed inset-0 z-[95] hidden items-center justify-center bg-black/80 backdrop-blur-md p-3 sm:p-6 overflow-y-auto";
    modal.setAttribute("role", "dialog");
    modal.setAttribute("aria-modal", "true");
    modal.addEventListener("click", (e) => {
      if (e.target === modal) {
        fecharModalRelatorio();
      }
    });
    document.body.appendChild(modal);
  }
  return modal;
}

/**
 * Abre o Modal de Relatório Técnico (./relatorio.md) para a aula informada.
 * Aceita (lessonId) ou (discId, lessonId).
 * @param {string} lessonIdOrDiscId
 * @param {string} [maybeLessonId]
 */
export async function abrirModalRelatorio(lessonIdOrDiscId, maybeLessonId = "") {
  if (typeof document === "undefined") return;

  const lessonId = maybeLessonId || lessonIdOrDiscId;
  const discId = maybeLessonId ? lessonIdOrDiscId : "";

  const { disc, aula } = localizarAulaNoDb(lessonId, discId);
  if (!aula) {
    mostrarToast("Atenção", "Aula não encontrada para abrir o Relatório Técnico.", "error");
    return;
  }

  const modal = obterOuCriarModalRelatorio();
  if (!modal) return;

  let artefatos = resolverArtefatosAula(aula);
  let relatorioDesc = artefatos.relatorio;
  const tituloAula = obterTituloAula(aula, store.getState().cacheMarkdownTexto);

  let markdownTexto = relatorioDesc?.markdown || "";
  if (!markdownTexto && relatorioDesc?.existe) {
    await hidratarConteudoAulaSobDemanda(aula);
    artefatos = resolverArtefatosAula(aula);
    relatorioDesc = artefatos.relatorio;
    markdownTexto = relatorioDesc?.markdown || (await carregarConteudoArtefato(relatorioDesc, aula.id, "text")) || "";
  }

  const htmlConteudo = markdownTexto
    ? obterHtmlMarkdownParseado(markdownTexto)
    : `
      <div class="p-6 rounded-xl bg-notion-card border border-notion-border text-center space-y-2">
        <div class="text-2xl">📄</div>
        <div class="text-sm font-bold text-white">Conteúdo do Relatório ainda não carregado</div>
        <p class="text-xs text-notion-muted">
          Vincule sua pasta local na barra lateral para carregar <code class="font-mono">./relatorio.md</code>.
        </p>
      </div>
    `;

  modal.innerHTML = `
    <div class="relative w-full max-w-4xl max-h-[90vh] bg-notion-sidebar border border-indigo-500/40 rounded-2xl shadow-2xl flex flex-col overflow-hidden text-notion-text">
      <!-- Cabeçalho -->
      <div class="px-5 py-4 border-b border-notion-border flex items-center justify-between gap-4 bg-gradient-to-r from-indigo-950/60 via-notion-bg to-violet-950/50 shrink-0">
        <div class="flex items-center gap-3 min-w-0">
          <span class="w-10 h-10 rounded-xl bg-indigo-500/20 border border-indigo-500/40 flex items-center justify-center text-xl shrink-0">
            📄
          </span>
          <div class="min-w-0">
            <div class="flex items-center gap-2 flex-wrap">
              <span class="text-[11px] font-mono uppercase tracking-wider text-indigo-300 font-bold">
                9. Relatório Técnico (./relatorio.md)
              </span>
              ${disc ? `<span class="text-xs font-mono text-notion-muted truncate">${escapeHtml(disc.icone || "📘")} ${escapeHtml(disc.nome)}</span>` : ""}
            </div>
            <h3 class="text-base sm:text-lg font-bold text-white truncate max-w-2xl mt-0.5">
              ${escapeHtml(tituloAula)}
            </h3>
          </div>
        </div>

        <button
          type="button"
          data-action="close-relatorio-modal"
          onclick="window.StudyOS?.fecharModalRelatorio()"
          class="w-8 h-8 rounded-lg bg-notion-card hover:bg-notion-hover text-notion-muted hover:text-white border border-notion-border flex items-center justify-center text-sm transition-colors cursor-pointer shrink-0"
          title="Fechar (Esc)"
        >
          ✕
        </button>
      </div>

      <!-- Conteúdo Markdown Renderizado -->
      <div class="p-5 sm:p-8 overflow-y-auto flex-1 bg-notion-bg/60">
        <article class="prose prose-invert prose-indigo max-w-none prose-headings:tracking-tight prose-p:leading-relaxed prose-li:my-1">
          ${htmlConteudo}
        </article>
      </div>

      <!-- Rodapé -->
      <div class="px-5 py-3 border-t border-notion-border bg-notion-card/60 flex items-center justify-between gap-3 text-xs shrink-0">
        <span class="font-mono text-[11px] text-notion-muted truncate">
          ${escapeHtml(relatorioDesc?.nome || "./relatorio.md")}
        </span>
        <button
          type="button"
          data-action="close-relatorio-modal"
          onclick="window.StudyOS?.fecharModalRelatorio()"
          class="px-4 py-2 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white font-mono text-xs font-semibold transition-colors cursor-pointer"
        >
          Fechar
        </button>
      </div>
    </div>
  `;

  modal.classList.remove("hidden");
  modal.classList.add("flex");
}

/**
 * Fecha o Modal de Relatório Técnico.
 */
export function fecharModalRelatorio() {
  if (typeof document === "undefined") return;
  const modal = document.getElementById("modal-relatorio-tecnico");
  if (modal) {
    modal.classList.add("hidden");
    modal.classList.remove("flex");
  }
}
