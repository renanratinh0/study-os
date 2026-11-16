/**
 * Study OS V2 - Sidebar Component
 * Gerenciamento e renderização da barra lateral esquerda em árvore hierárquica
 * com colapso dinâmico de semestres e contadores de itens.
 */

import { store, obterTodasDisciplinas } from "../core/store.js";
import { escapeHtml } from "../utils/domHelpers.js";

export function renderSidebar() {
  if (typeof document === "undefined") return;
  const container = document.getElementById("sidebar-tree");
  const countBadge = document.getElementById("db-count-badge");
  if (!container) return;

  const state = store.getState();
  const todas = obterTodasDisciplinas(state.db);
  if (countBadge) countBadge.textContent = `${todas.length} matérias`;

  if (!state.db || !Array.isArray(state.db.semestres) || state.db.semestres.length === 0) {
    container.innerHTML = `
      <div class="p-3 rounded-xl bg-notion-card/60 border border-notion-border text-notion-muted text-[11px] space-y-2">
        <p class="font-semibold text-notion-text">Nenhum db.json carregado</p>
        <p>Clique em <strong>Importar db.json</strong> abaixo ou arraste seu arquivo para a tela.</p>
      </div>
    `;
    return;
  }

  const hashAtual = (typeof window !== "undefined" ? window.location.hash : "") || "#/";
  container.innerHTML = state.db.semestres.map(sem => {
    const isExpanded = state.semestresExpandidos.has(sem.id);
    const disciplinasHtml = (sem.disciplinas || []).map(disc => {
      const rotaDisc = `#/disciplina/${disc.id}`;
      const ativo = hashAtual.startsWith(rotaDisc);
      return `
        <a href="${rotaDisc}" class="flex items-center justify-between gap-2 px-2.5 py-1.5 rounded-lg transition-colors ${ativo ? 'bg-indigo-600/20 text-indigo-300 font-semibold border border-indigo-500/30' : 'text-notion-muted hover:bg-notion-hover hover:text-notion-text'}">
          <span class="flex items-center gap-2 truncate">
            <span class="shrink-0 text-sm">${disc.icone || '📘'}</span>
            <span class="truncate">${escapeHtml(disc.nome)}</span>
          </span>
          <span class="text-[10px] font-mono opacity-60 shrink-0">${(disc.aulas || []).length}</span>
        </a>
      `;
    }).join("");

    return `
      <div class="space-y-0.5">
        <button type="button" data-sem-id="${sem.id}" class="btn-toggle-semestre w-full flex items-center justify-between px-2 py-1.5 rounded-lg text-left font-semibold text-notion-text hover:bg-notion-hover transition-colors cursor-pointer">
          <span class="flex items-center gap-1.5 truncate">
            <span class="text-[10px] text-notion-muted transition-transform ${isExpanded ? 'rotate-90' : ''}">▶</span>
            <span class="truncate">${escapeHtml(sem.nome)}</span>
          </span>
          <span class="text-[10px] font-mono px-1.5 py-0.2 rounded bg-notion-card border border-notion-border text-notion-muted">${(sem.disciplinas || []).length}</span>
        </button>
        <div class="${isExpanded ? 'block' : 'hidden'} pl-3 border-l border-notion-border/60 ml-2.5 space-y-0.5">
          ${disciplinasHtml}
        </div>
      </div>
    `;
  }).join("");

  // Delegação de evento para os botões de toggle
  container.querySelectorAll(".btn-toggle-semestre").forEach(btn => {
    btn.onclick = () => {
      const semId = btn.getAttribute("data-sem-id");
      if (semId) {
        store.toggleSemestreExpandido(semId);
        renderSidebar();
      }
    };
  });
}
