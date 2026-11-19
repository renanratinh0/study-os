/**
 * Study OS V2 - Tactical Quiz Simulator Component (Camada 8)
 * Simulador interativo de questões Markdown (./quiz.md) com:
 *  - Barra de navegação por pílulas (Q01, Q02...) coloridas por acerto/erro
 *  - Feedback instantâneo com travamento da questão (✔ verde / ✖ vermelho)
 *  - Dica Tática expansível (**Hint:**) em bloco âmbar sutil
 *  - Alternância Modo Foco (1 por vez) vs. Modo Lista (todas)
 *  - Persistência de placar e respostas por aula no storage.js
 */

import { escapeHtml } from "../utils/domHelpers.js";
import { parseQuizMarkdown } from "../utils/artifactsParser.js";
import {
  obterProgressoQuiz,
  salvarProgressoQuiz,
  limparProgressoQuiz
} from "../services/storage.js";

const _activeQuizzes = new Map();

/**
 * Renderiza o container HTML estrutural da Camada 8 (Quiz Simulador Tático).
 * @param {object} aula
 * @param {object} descriptor
 * @returns {string}
 */
export function renderQuizSectionHtml(aula, descriptor) {
  if (!descriptor || !descriptor.existe) return "";
  const idBase = escapeHtml(aula.id);
  const questoesIniciais = parseQuizMarkdown(descriptor.markdown || "");
  const total = questoesIniciais.length;
  const salvo = obterProgressoQuiz(aula.id);
  const acertos = Object.values(salvo.answers || {}).filter(a => a.isCorrect).length;

  return `
    <section
      id="section-quiz-${idBase}"
      data-quiz-root="${idBase}"
      class="rounded-2xl bg-gradient-to-br from-[#140e0a] via-notion-bg to-[#110c19] border border-orange-500/35 shadow-2xl overflow-hidden text-notion-text"
    >
      <!-- Cabeçalho -->
      <div class="px-4 sm:px-5 py-3.5 border-b border-orange-500/20 bg-black/30 flex flex-wrap items-center justify-between gap-3">
        <div class="flex items-center gap-2.5 flex-wrap">
          <span class="px-2.5 py-1 rounded-lg bg-orange-500/15 text-orange-300 border border-orange-500/35 font-mono text-[11px] font-bold uppercase tracking-wider flex items-center gap-1.5">
            <span>🎯 8. Quiz Simulador Tático</span>
            <span class="text-orange-400/70 font-normal">(./quiz.md)</span>
          </span>
        </div>
        <div class="flex items-center gap-2 font-mono text-xs">
          <span
            data-quiz-score
            class="px-3 py-1 rounded-lg bg-black/45 border border-white/10 text-emerald-300 font-bold"
          >
            Acertos: ${acertos} / ${total}
          </span>
        </div>
      </div>

      <!-- Corpo interativo hidratado pelo mountQuizSimulator -->
      <div data-quiz-body class="p-4 sm:p-6 space-y-5">
        ${total === 0 ? `
          <div class="py-10 text-center space-y-2">
            <div class="text-3xl">🎯</div>
            <div class="text-xs font-mono text-orange-300 font-bold">Nenhuma questão carregada</div>
            <p class="text-[11px] text-notion-muted">Vincule a pasta local na barra lateral para ler <code class="font-mono">./quiz.md</code>.</p>
          </div>
        ` : ""}
      </div>
    </section>
  `;
}

/**
 * Monta e hidrata o simulador de Quiz interativo para uma aula.
 * @param {HTMLElement} containerEl
 * @param {object} aula
 * @param {string} markdownText
 */
export function mountQuizSimulator(containerEl, aula, markdownText) {
  if (typeof document === "undefined" || !containerEl || !aula) return null;

  const rootSection = containerEl.querySelector(`[data-quiz-root="${aula.id}"]`)
    || (containerEl.matches?.(`[data-quiz-root="${aula.id}"]`) ? containerEl : null);
  if (!rootSection) return null;

  destroyQuizSimulator(aula.id);

  const bodyEl = rootSection.querySelector("[data-quiz-body]");
  const scoreEl = rootSection.querySelector("[data-quiz-score]");
  if (!bodyEl) return null;

  const questions = parseQuizMarkdown(markdownText || "");
  if (questions.length === 0) return null;

  const progressoSalvo = obterProgressoQuiz(aula.id);

  const state = {
    questions,
    answers: { ...(progressoSalvo.answers || {}) },
    hintsOpen: new Set(),
    activeIndex: 0,
    viewMode: "focus" // 'focus' | 'list'
  };

  function calcularAcertos() {
    let acertos = 0;
    let respondidas = 0;
    questions.forEach(q => {
      const resp = state.answers[q.id];
      if (resp && resp.selectedIndex !== undefined) {
        respondidas++;
        if (resp.isCorrect) acertos++;
      }
    });
    return { acertos, respondidas, total: questions.length };
  }

  function atualizarScoreHeader() {
    if (!scoreEl) return;
    const { acertos, total } = calcularAcertos();
    scoreEl.textContent = `Acertos: ${acertos} / ${total}`;
  }

  function renderQuestionCard(q, idx) {
    const resp = state.answers[q.id];
    const travada = Boolean(resp && resp.selectedIndex !== undefined);
    const dicaVisivel = state.hintsOpen.has(q.id);
    const numStr = String(q.number).padStart(2, "0");

    return `
      <div
        data-quiz-card="${escapeHtml(q.id)}"
        class="p-4 sm:p-6 rounded-2xl bg-black/40 border ${
          travada
            ? (resp.isCorrect ? "border-emerald-500/45" : "border-rose-500/45")
            : "border-white/10"
        } space-y-4 transition-all"
      >
        <!-- Topo da questão -->
        <div class="flex flex-wrap items-center justify-between gap-2">
          <div class="flex items-center gap-2">
            <span class="px-2.5 py-0.5 rounded-lg bg-orange-500/20 text-orange-300 border border-orange-500/35 font-mono text-[11px] font-bold">
              QUESTÃO ${numStr} / ${String(questions.length).padStart(2, "0")}
            </span>
            ${travada ? (
              resp.isCorrect
                ? `<span class="px-2 py-0.5 rounded-lg bg-emerald-500/20 text-emerald-300 border border-emerald-500/40 font-mono text-[10px] font-bold">✔ Resposta Correta</span>`
                : `<span class="px-2 py-0.5 rounded-lg bg-rose-500/20 text-rose-300 border border-rose-500/40 font-mono text-[10px] font-bold">✖ Resposta Incorreta</span>`
            ) : ""}
          </div>

          ${q.hint ? `
            <button
              type="button"
              data-quiz-toggle-hint="${escapeHtml(q.id)}"
              class="px-3 py-1 rounded-lg bg-amber-500/15 hover:bg-amber-500/25 border border-amber-500/35 text-amber-300 font-mono text-[11px] transition-colors cursor-pointer flex items-center gap-1.5"
            >
              <span>💡</span>
              <span>${dicaVisivel ? "Ocultar Dica Tática" : "Revelar Dica Tática"}</span>
            </button>
          ` : ""}
        </div>

        <!-- Enunciado -->
        <p class="text-sm sm:text-base font-medium text-white leading-relaxed">
          ${escapeHtml(q.prompt)}
        </p>

        <!-- Bloco de Dica Tática -->
        ${(q.hint && dicaVisivel) ? `
          <div class="p-3.5 rounded-xl bg-amber-500/10 border border-amber-500/30 text-xs text-amber-200 leading-relaxed flex items-start gap-2.5">
            <span class="text-base shrink-0">💡</span>
            <div>
              <span class="font-mono text-[10px] uppercase tracking-wider text-amber-300 font-bold block mb-0.5">Dica Tática</span>
              <span>${escapeHtml(q.hint)}</span>
            </div>
          </div>
        ` : ""}

        <!-- Alternativas -->
        <div class="space-y-2.5">
          ${q.options.map((opt, optIdx) => {
            const foiEscolhida = travada && resp.selectedIndex === optIdx;
            const ehCorreta = opt.correct;

            let btnClasses = "bg-notion-card/70 hover:bg-orange-500/15 border-white/10 hover:border-orange-400/50 text-zinc-200 cursor-pointer";
            let badgeClasses = "bg-black/40 border-white/15 text-zinc-300";
            let statusIcon = "";

            if (travada) {
              if (ehCorreta) {
                btnClasses = "bg-emerald-500/20 border-emerald-400/70 text-emerald-100 cursor-default shadow-sm";
                badgeClasses = "bg-emerald-500 text-white border-emerald-400";
                statusIcon = `<span class="ml-auto font-mono font-bold text-emerald-300 text-sm shrink-0">✔</span>`;
              } else if (foiEscolhida && !ehCorreta) {
                btnClasses = "bg-rose-500/20 border-rose-400/70 text-rose-100 cursor-default";
                badgeClasses = "bg-rose-500 text-white border-rose-400";
                statusIcon = `<span class="ml-auto font-mono font-bold text-rose-300 text-sm shrink-0">✖</span>`;
              } else {
                btnClasses = "bg-black/30 border-white/5 text-zinc-500 opacity-65 cursor-default";
                badgeClasses = "bg-black/30 border-white/10 text-zinc-500";
              }
            }

            return `
              <button
                type="button"
                data-quiz-answer="${escapeHtml(q.id)}"
                data-opt-index="${optIdx}"
                ${travada ? "disabled" : ""}
                class="w-full text-left p-3.5 rounded-xl border transition-all flex items-center gap-3 ${btnClasses}"
              >
                <span class="w-7 h-7 rounded-lg border font-mono text-xs font-bold flex items-center justify-center shrink-0 ${badgeClasses}">
                  ${escapeHtml(opt.letter)}
                </span>
                <span class="text-xs sm:text-sm leading-relaxed flex-1">${escapeHtml(opt.text)}</span>
                ${statusIcon}
              </button>
            `;
          }).join("")}
        </div>
      </div>
    `;
  }

  function renderQuiz() {
    atualizarScoreHeader();
    const { acertos, respondidas, total } = calcularAcertos();
    const questaoAtiva = questions[state.activeIndex] || questions[0];

    bodyEl.innerHTML = `
      <!-- Barra de Pílulas & Controles de Modo -->
      <div class="flex flex-col lg:flex-row lg:items-center justify-between gap-3">
        <div class="flex items-center gap-1.5 flex-wrap">
          ${questions.map((q, idx) => {
            const resp = state.answers[q.id];
            const isActive = state.viewMode === "focus" && idx === state.activeIndex;
            const numPill = `Q${String(q.number).padStart(2, "0")}`;

            let pillClass = "bg-black/45 text-zinc-300 border-white/15 hover:border-orange-400/60";
            if (resp && resp.isCorrect) {
              pillClass = "bg-emerald-500/25 text-emerald-200 border-emerald-400/60";
            } else if (resp && !resp.isCorrect) {
              pillClass = "bg-rose-500/25 text-rose-200 border-rose-400/60";
            }
            if (isActive) {
              pillClass += " ring-2 ring-orange-400 ring-offset-1 ring-offset-black";
            }

            return `
              <button
                type="button"
                data-quiz-pill="${idx}"
                class="px-2.5 py-1 rounded-lg border font-mono text-[11px] font-bold transition-all cursor-pointer ${pillClass}"
              >
                ${numPill}
              </button>
            `;
          }).join("")}
        </div>

        <div class="flex items-center gap-2 flex-wrap">
          <button
            type="button"
            data-quiz-toggle-mode
            class="px-3 py-1.5 rounded-xl border text-xs font-mono transition-all cursor-pointer ${
              state.viewMode === "list"
                ? "bg-orange-600 text-white border-orange-400"
                : "bg-black/50 hover:bg-orange-500/20 border-white/10 hover:border-orange-400/50 text-orange-300"
            }"
          >
            ${state.viewMode === "list" ? "🎯 Modo Foco (1 por vez)" : "📜 Ver Todas as Questões"}
          </button>
          <button
            type="button"
            data-quiz-reset
            class="px-3 py-1.5 rounded-xl bg-black/50 hover:bg-rose-500/20 border border-white/10 hover:border-rose-500/40 text-xs font-mono text-zinc-300 hover:text-rose-200 transition-colors cursor-pointer"
          >
            ↺ Reiniciar Quiz
          </button>
        </div>
      </div>

      ${respondidas === total && total > 0 ? `
        <div class="p-3.5 rounded-xl bg-gradient-to-r from-emerald-950/50 via-black/40 to-cyan-950/50 border border-emerald-500/40 flex flex-wrap items-center justify-between gap-2 text-xs">
          <div class="flex items-center gap-2 font-mono">
            <span class="text-base">🏆</span>
            <span class="text-emerald-200 font-bold">Simulado Concluído!</span>
            <span class="text-zinc-300">Você acertou <strong class="text-white">${acertos} de ${total}</strong> (${Math.round((acertos / total) * 100)}%).</span>
          </div>
          <button
            type="button"
            data-quiz-reset
            class="px-3 py-1 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white font-mono text-[11px] font-bold cursor-pointer"
          >
            Refazer Simulado
          </button>
        </div>
      ` : ""}

      <!-- Questão(ões) -->
      ${state.viewMode === "focus" ? `
        <div class="space-y-4">
          ${renderQuestionCard(questaoAtiva, state.activeIndex)}
          <div class="flex items-center justify-between gap-2">
            <button
              type="button"
              data-quiz-prev
              ${state.activeIndex === 0 ? "disabled" : ""}
              class="px-3.5 py-2 rounded-xl bg-black/50 hover:bg-white/10 disabled:opacity-40 disabled:cursor-not-allowed border border-white/15 text-xs font-mono text-zinc-200 transition-colors cursor-pointer"
            >
              ← Anterior
            </button>
            <span class="text-[11px] font-mono text-zinc-400">
              ${respondidas} de ${total} respondida(s)
            </span>
            <button
              type="button"
              data-quiz-next
              ${state.activeIndex >= questions.length - 1 ? "disabled" : ""}
              class="px-3.5 py-2 rounded-xl bg-orange-600/80 hover:bg-orange-500 disabled:opacity-40 disabled:cursor-not-allowed border border-orange-400/50 text-xs font-mono text-white font-bold transition-colors cursor-pointer"
            >
              Próxima →
            </button>
          </div>
        </div>
      ` : `
        <div class="space-y-4">
          ${questions.map((q, idx) => renderQuestionCard(q, idx)).join("")}
        </div>
      `}
    `;
  }

  const onClick = (e) => {
    const answerBtn = e.target.closest("[data-quiz-answer]");
    if (answerBtn) {
      const qId = answerBtn.getAttribute("data-quiz-answer");
      const optIdx = parseInt(answerBtn.getAttribute("data-opt-index"), 10);
      const question = questions.find(q => q.id === qId);
      if (!question || state.answers[qId]) return;

      const optEscolhida = question.options[optIdx];
      if (!optEscolhida) return;

      state.answers[qId] = {
        selectedIndex: optIdx,
        isCorrect: Boolean(optEscolhida.correct)
      };

      const { acertos, total } = calcularAcertos();
      salvarProgressoQuiz(aula.id, {
        answers: state.answers,
        score: acertos,
        total
      });
      renderQuiz();
      return;
    }

    const hintBtn = e.target.closest("[data-quiz-toggle-hint]");
    if (hintBtn) {
      const qId = hintBtn.getAttribute("data-quiz-toggle-hint");
      if (state.hintsOpen.has(qId)) state.hintsOpen.delete(qId);
      else state.hintsOpen.add(qId);
      renderQuiz();
      return;
    }

    const pillBtn = e.target.closest("[data-quiz-pill]");
    if (pillBtn) {
      const idx = parseInt(pillBtn.getAttribute("data-quiz-pill"), 10);
      if (Number.isFinite(idx) && idx >= 0 && idx < questions.length) {
        state.activeIndex = idx;
        if (state.viewMode === "list") {
          const targetCard = bodyEl.querySelector(`[data-quiz-card="${questions[idx].id}"]`);
          targetCard?.scrollIntoView({ behavior: "smooth", block: "center" });
        } else {
          renderQuiz();
        }
      }
      return;
    }

    if (e.target.closest("[data-quiz-toggle-mode]")) {
      state.viewMode = state.viewMode === "focus" ? "list" : "focus";
      renderQuiz();
      return;
    }

    if (e.target.closest("[data-quiz-prev]")) {
      if (state.activeIndex > 0) {
        state.activeIndex--;
        renderQuiz();
      }
      return;
    }

    if (e.target.closest("[data-quiz-next]")) {
      if (state.activeIndex < questions.length - 1) {
        state.activeIndex++;
        renderQuiz();
      }
      return;
    }

    if (e.target.closest("[data-quiz-reset]")) {
      state.answers = {};
      state.hintsOpen.clear();
      state.activeIndex = 0;
      limparProgressoQuiz(aula.id);
      renderQuiz();
    }
  };

  bodyEl.addEventListener("click", onClick);
  renderQuiz();

  const instance = {
    getState: () => state,
    destroy: () => {
      bodyEl.removeEventListener("click", onClick);
    }
  };

  _activeQuizzes.set(aula.id, instance);
  return instance;
}

export function destroyQuizSimulator(aulaId) {
  if (!aulaId) return;
  const inst = _activeQuizzes.get(aulaId);
  if (inst) {
    inst.destroy();
    _activeQuizzes.delete(aulaId);
  }
}
