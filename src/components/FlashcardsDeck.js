/**
 * Study OS V2 - Flashcards 3D + SRS Deck Component (Camada 7)
 * Renderiza flashcards interativos com palco 3D Flip, Sistema de Repetição Espaçada (SRS)
 * persistente por aula no localStorage, filtros por status SRS, busca textual, Shuffle,
 * Grade Completa e atalhos de teclado (Espaço, ←/→, 1/2/3).
 */

import { escapeHtml } from "../utils/domHelpers.js";
import { parseFlashcardsMarkdown } from "../utils/artifactsParser.js";
import {
  obterProgressoFlashcards,
  salvarAvaliacaoFlashcard,
  limparProgressoFlashcards
} from "../services/storage.js";

const _activeFlashcardsDecks = new Map();
let _lastInteractedDeckId = null;
let _keyboardBound = false;

function getSrsMeta(rating) {
  if (rating === "hard") {
    return {
      key: "hard",
      label: "🔴 Revisar",
      badgeClass: "bg-rose-500/20 text-rose-300 border-rose-500/40"
    };
  }
  if (rating === "medium") {
    return {
      key: "medium",
      label: "🟡 Médio",
      badgeClass: "bg-amber-500/20 text-amber-300 border-amber-500/40"
    };
  }
  if (rating === "easy") {
    return {
      key: "easy",
      label: "🟢 Dominado",
      badgeClass: "bg-emerald-500/20 text-emerald-300 border-emerald-500/40"
    };
  }
  return {
    key: "new",
    label: "⚪ Novo",
    badgeClass: "bg-zinc-800/80 text-zinc-300 border-white/10"
  };
}

function embaralharLista(lista) {
  const copia = [...lista];
  for (let i = copia.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copia[i], copia[j]] = [copia[j], copia[i]];
  }
  return copia;
}

/**
 * Renderiza o container HTML da Camada 7 (Flashcards 3D + SRS).
 * @param {object} aula
 * @param {object} descriptor
 * @returns {string}
 */
export function renderFlashcardsSectionHtml(aula, descriptor) {
  if (!descriptor || !descriptor.existe) return "";
  const idBase = escapeHtml(aula.id);
  const cardsIniciais = parseFlashcardsMarkdown(descriptor.markdown || "");
  const total = cardsIniciais.length;

  return `
    <section
      id="section-flashcards-${idBase}"
      data-flashcards-root="${idBase}"
      tabindex="-1"
      class="rounded-2xl bg-gradient-to-br from-[#0e0c1a] via-notion-bg to-[#0a101d] border border-violet-500/35 shadow-2xl overflow-hidden text-notion-text outline-none"
    >
      <!-- Cabeçalho -->
      <div class="px-4 sm:px-5 py-3.5 border-b border-violet-500/20 bg-black/30 flex flex-wrap items-center justify-between gap-3">
        <div class="flex items-center gap-2.5 flex-wrap">
          <span class="px-2.5 py-1 rounded-lg bg-violet-500/15 text-violet-300 border border-violet-500/35 font-mono text-[11px] font-bold uppercase tracking-wider flex items-center gap-1.5">
            <span>🃏 7. Flashcards 3D + SRS</span>
            <span class="text-violet-400/70 font-normal">(./flashcards.md)</span>
          </span>
        </div>
        <div class="flex items-center gap-2 font-mono text-xs">
          <span
            data-fc-counter
            class="px-2.5 py-1 rounded-lg bg-black/40 border border-white/10 text-cyan-300 font-bold"
          >
            ${total > 0 ? `Card 1 de ${total}` : "0 cards"}
          </span>
        </div>
      </div>

      <!-- Corpo interativo hidratado pelo mountFlashcardsDeck -->
      <div data-fc-body class="p-4 sm:p-6 space-y-5">
        ${total === 0 ? `
          <div class="py-10 text-center space-y-2">
            <div class="text-3xl">🃏</div>
            <div class="text-xs font-mono text-violet-300 font-bold">Nenhum flashcard carregado</div>
            <p class="text-[11px] text-notion-muted">Vincule a pasta local na barra lateral para ler <code class="font-mono">./flashcards.md</code>.</p>
          </div>
        ` : ""}
      </div>
    </section>
  `;
}

function garantirAtalhosTecladoGlobais() {
  if (_keyboardBound || typeof document === "undefined") return;
  _keyboardBound = true;

  document.addEventListener("keydown", (e) => {
    if (_activeFlashcardsDecks.size === 0) return;

    const tag = String(e.target?.tagName || "").toLowerCase();
    if (["input", "textarea", "select"].includes(tag) || e.target?.isContentEditable) {
      return;
    }

    // Não intercepta caso algum modal esteja aberto
    const modaisBloqueantes = [
      "modal-relatorio-tecnico",
      "playlist-immersive-modal",
      "playlist-choice-modal",
      "search-modal",
      "modal-atividade",
      "modal-editar-disciplina",
      "modal-data-aula",
      "modal-senha-admin",
      "modal-arquivos-referencias"
    ];
    for (const modalId of modaisBloqueantes) {
      const el = document.getElementById(modalId);
      if (el && !el.classList.contains("hidden")) return;
    }

    // Seleciona o deck ativo mais recente (ou o único montado)
    let deck = _lastInteractedDeckId ? _activeFlashcardsDecks.get(_lastInteractedDeckId) : null;
    if (!deck) {
      deck = _activeFlashcardsDecks.values().next().value || null;
    }
    if (!deck) return;

    const st = deck.getState();
    if (st.viewMode !== "card" || st.filteredCards.length === 0) return;

    if (e.code === "Space" || e.key === " ") {
      e.preventDefault();
      deck.flipCard();
    } else if (e.key === "ArrowRight") {
      e.preventDefault();
      deck.nextCard();
    } else if (e.key === "ArrowLeft") {
      e.preventDefault();
      deck.prevCard();
    } else if (e.key === "1") {
      e.preventDefault();
      deck.rateCurrentAndAdvance("hard");
    } else if (e.key === "2") {
      e.preventDefault();
      deck.rateCurrentAndAdvance("medium");
    } else if (e.key === "3") {
      e.preventDefault();
      deck.rateCurrentAndAdvance("easy");
    }
  });
}

/**
 * Monta e hidrata o deck interativo de Flashcards 3D + SRS para uma aula.
 * @param {HTMLElement} containerEl
 * @param {object} aula
 * @param {string} markdownText
 */
export function mountFlashcardsDeck(containerEl, aula, markdownText) {
  if (typeof document === "undefined" || !containerEl || !aula) return null;

  const rootSection = containerEl.querySelector(`[data-flashcards-root="${aula.id}"]`)
    || (containerEl.matches?.(`[data-flashcards-root="${aula.id}"]`) ? containerEl : null);
  if (!rootSection) return null;

  destroyFlashcardsDeck(aula.id);

  const bodyEl = rootSection.querySelector("[data-fc-body]");
  const counterEl = rootSection.querySelector("[data-fc-counter]");
  if (!bodyEl) return null;

  const baseCards = parseFlashcardsMarkdown(markdownText || "");
  if (baseCards.length === 0) {
    return null;
  }

  garantirAtalhosTecladoGlobais();

  const state = {
    cardsOrder: [...baseCards],
    filteredCards: [...baseCards],
    currentIndex: 0,
    flipped: false,
    srsFilter: "all", // 'all' | 'hard' | 'medium' | 'easy'
    viewMode: "card", // 'card' | 'grid'
    srsMap: obterProgressoFlashcards(aula.id)
  };

  function recomputarFiltro(manterCardId = null) {
    state.filteredCards = state.cardsOrder.filter(card => {
      const rating = state.srsMap[card.id]?.rating || "new";
      if (state.srsFilter !== "all" && rating !== state.srsFilter) {
        return false;
      }
      return true;
    });

    if (manterCardId) {
      const idxEncontrado = state.filteredCards.findIndex(c => c.id === manterCardId);
      state.currentIndex = idxEncontrado >= 0 ? idxEncontrado : 0;
    } else if (state.currentIndex >= state.filteredCards.length) {
      state.currentIndex = Math.max(0, state.filteredCards.length - 1);
    }
  }

  function atualizarContadorHeader() {
    if (!counterEl) return;
    const totalFilt = state.filteredCards.length;
    if (totalFilt === 0) {
      counterEl.textContent = `0 de ${baseCards.length}`;
    } else {
      counterEl.textContent = `Card ${state.currentIndex + 1} de ${totalFilt}`;
    }
  }

  function renderDeck() {
    recomputarFiltro();
    atualizarContadorHeader();

    let countHard = 0;
    let countMed = 0;
    let countEasy = 0;
    baseCards.forEach(c => {
      const r = state.srsMap[c.id]?.rating;
      if (r === "hard") countHard++;
      else if (r === "medium") countMed++;
      else if (r === "easy") countEasy++;
    });

    const cardAtual = state.filteredCards[state.currentIndex] || null;
    const ratingAtual = cardAtual ? (state.srsMap[cardAtual.id]?.rating || "new") : "new";
    const srsAtualMeta = getSrsMeta(ratingAtual);
    const numFormatado = cardAtual ? String(cardAtual.number).padStart(2, "0") : "00";

    const filterBtnClass = (key, activeClasses) => {
      const ativo = state.srsFilter === key;
      return `px-2.5 py-1 rounded-lg text-[11px] font-mono border transition-all cursor-pointer ${
        ativo
          ? activeClasses
          : "bg-black/40 text-zinc-400 border-white/10 hover:text-white hover:border-white/25"
      }`;
    };

    bodyEl.innerHTML = `
      <!-- Barra de Filtros SRS, Shuffle e Alternância de Visão -->
      <div class="flex flex-col lg:flex-row lg:items-center justify-between gap-3">
        <div class="flex items-center gap-1.5 flex-wrap">
          <button type="button" data-fc-filter="all" class="${filterBtnClass("all", "bg-violet-600 text-white border-violet-400 shadow-xs")}">
            Todos (${baseCards.length})
          </button>
          <button type="button" data-fc-filter="hard" class="${filterBtnClass("hard", "bg-rose-500/25 text-rose-200 border-rose-400/60")}">
            🔴 Revisar (${countHard})
          </button>
          <button type="button" data-fc-filter="medium" class="${filterBtnClass("medium", "bg-amber-500/25 text-amber-200 border-amber-400/60")}">
            🟡 Médio (${countMed})
          </button>
          <button type="button" data-fc-filter="easy" class="${filterBtnClass("easy", "bg-emerald-500/25 text-emerald-200 border-emerald-400/60")}">
            🟢 Dominado (${countEasy})
          </button>
        </div>

        <div class="flex items-center gap-2 flex-wrap">
          <button
            type="button"
            data-fc-shuffle
            class="px-3 py-1.5 rounded-xl bg-black/50 hover:bg-violet-600/30 border border-white/10 hover:border-violet-400/50 text-xs font-mono text-zinc-200 transition-all cursor-pointer"
            title="Embaralhar ordem dos cards"
          >
            🔀 Shuffle
          </button>

          <button
            type="button"
            data-fc-toggle-view
            class="px-3 py-1.5 rounded-xl border text-xs font-mono transition-all cursor-pointer ${
              state.viewMode === "grid"
                ? "bg-cyan-600 text-white border-cyan-400"
                : "bg-black/50 hover:bg-cyan-600/25 border-white/10 hover:border-cyan-400/50 text-cyan-300"
            }"
          >
            ${state.viewMode === "grid" ? "🃏 Modo Cartão 3D" : "📋 Ver Grade Completa"}
          </button>

          ${(countHard + countMed + countEasy) > 0 ? `
            <button
              type="button"
              data-fc-reset-srs
              class="px-2.5 py-1.5 rounded-xl bg-black/40 hover:bg-rose-500/20 border border-white/10 hover:border-rose-500/40 text-[11px] font-mono text-zinc-400 hover:text-rose-300 transition-colors cursor-pointer"
              title="Limpar progresso SRS desta aula"
            >
              ↺ Zerar SRS
            </button>
          ` : ""}
        </div>
      </div>

      ${state.filteredCards.length === 0 ? `
        <div class="p-8 rounded-2xl bg-black/30 border border-white/10 text-center space-y-2">
          <div class="text-2xl">🔍</div>
          <div class="text-xs font-mono font-bold text-white">Nenhum flashcard corresponde aos filtros atuais.</div>
          <button
            type="button"
            data-fc-clear-all
            class="mt-1 px-3 py-1.5 rounded-lg bg-violet-600 hover:bg-violet-500 text-white text-xs font-mono cursor-pointer"
          >
            Mostrar Todos (${baseCards.length})
          </button>
        </div>
      ` : state.viewMode === "grid" ? `
        <!-- VISÃO GRADE COMPLETA -->
        <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
          ${state.filteredCards.map((c, idx) => {
            const meta = getSrsMeta(state.srsMap[c.id]?.rating);
            const num = String(c.number).padStart(2, "0");
            return `
              <div class="p-4 rounded-2xl bg-black/45 border border-violet-500/25 hover:border-cyan-400/50 transition-all flex flex-col justify-between gap-3">
                <div class="space-y-2.5">
                  <div class="flex items-center justify-between gap-2">
                    <span class="px-2 py-0.5 rounded bg-violet-500/20 text-violet-300 border border-violet-500/35 font-mono text-[10px] font-bold">
                      CARD #${num}
                    </span>
                    <span class="px-2 py-0.5 rounded border font-mono text-[10px] ${meta.badgeClass}">
                      ${meta.label}
                    </span>
                  </div>
                  <div class="text-xs sm:text-sm font-semibold text-white leading-relaxed">
                    ${escapeHtml(c.question)}
                  </div>
                  <div class="p-3 rounded-xl bg-gradient-to-r from-cyan-950/40 to-violet-950/40 border border-cyan-500/25 text-xs text-cyan-100 leading-relaxed">
                    <span class="block font-mono text-[10px] text-cyan-300 uppercase font-bold mb-1">Resposta Oficial</span>
                    ${escapeHtml(c.answer)}
                  </div>
                </div>
                <div class="pt-2 border-t border-white/10 flex items-center justify-between gap-2">
                  <div class="flex items-center gap-1">
                    <button type="button" data-fc-grid-rate="hard" data-card-id="${escapeHtml(c.id)}" class="px-2 py-1 rounded-lg bg-rose-500/15 hover:bg-rose-500/30 text-rose-300 border border-rose-500/30 text-[10px] font-mono cursor-pointer">🔴</button>
                    <button type="button" data-fc-grid-rate="medium" data-card-id="${escapeHtml(c.id)}" class="px-2 py-1 rounded-lg bg-amber-500/15 hover:bg-amber-500/30 text-amber-300 border border-amber-500/30 text-[10px] font-mono cursor-pointer">🟡</button>
                    <button type="button" data-fc-grid-rate="easy" data-card-id="${escapeHtml(c.id)}" class="px-2 py-1 rounded-lg bg-emerald-500/15 hover:bg-emerald-500/30 text-emerald-300 border border-emerald-500/30 text-[10px] font-mono cursor-pointer">🟢</button>
                  </div>
                  <button
                    type="button"
                    data-fc-open-in-3d="${idx}"
                    class="text-[11px] font-mono text-cyan-300 hover:text-white hover:underline cursor-pointer"
                  >
                    Estudar em 3D →
                  </button>
                </div>
              </div>
            `;
          }).join("")}
        </div>
      ` : `
        <!-- PALCO 3D FLIP -->
        <div class="max-w-3xl mx-auto space-y-4">
          <div
            data-fc-stage
            class="flashcard-scene w-full min-h-[250px] sm:min-h-[280px] cursor-pointer select-none"
            style="perspective: 1200px;"
            title="Clique para virar o cartão (ou pressione Espaço)"
          >
            <div
              data-fc-inner
              class="flashcard-inner relative w-full min-h-[250px] sm:min-h-[280px] transition-transform duration-500"
              style="transform-style: preserve-3d; transform: ${state.flipped ? "rotateY(180deg)" : "rotateY(0deg)"};"
            >
              <!-- FRENTE: PERGUNTA -->
              <div
                class="flashcard-face absolute inset-0 w-full h-full rounded-2xl p-5 sm:p-8 bg-gradient-to-br from-[#131524] via-[#0e101c] to-[#17122a] border border-violet-500/40 shadow-2xl flex flex-col justify-between"
                style="backface-visibility: hidden; -webkit-backface-visibility: hidden;"
              >
                <div class="flex items-center justify-between gap-2">
                  <span class="px-2.5 py-1 rounded-lg bg-violet-500/20 text-violet-300 border border-violet-500/40 font-mono text-[11px] font-bold tracking-wider">
                    CARD #${numFormatado} • PERGUNTA
                  </span>
                  <span class="px-2.5 py-0.5 rounded-lg border font-mono text-[10px] ${srsAtualMeta.badgeClass}">
                    ${srsAtualMeta.label}
                  </span>
                </div>

                <div class="my-auto py-4 text-center">
                  <p class="text-base sm:text-xl font-bold text-white leading-relaxed">
                    ${escapeHtml(cardAtual.question)}
                  </p>
                </div>

                <div class="flex items-center justify-center gap-2 text-[11px] font-mono text-zinc-400">
                  <span class="px-2.5 py-1 rounded-full bg-white/5 border border-white/10">🔄 Clique ou pressione <strong class="text-violet-300">Espaço</strong> para revelar resposta</span>
                </div>
              </div>

              <!-- VERSO: RESPOSTA OFICIAL -->
              <div
                class="flashcard-face flashcard-back absolute inset-0 w-full h-full rounded-2xl p-5 sm:p-8 bg-gradient-to-br from-cyan-950/80 via-[#0b1322] to-violet-950/80 border-2 border-cyan-400/55 shadow-2xl flex flex-col justify-between"
                style="backface-visibility: hidden; -webkit-backface-visibility: hidden; transform: rotateY(180deg);"
              >
                <div class="flex items-center justify-between gap-2">
                  <span class="px-2.5 py-1 rounded-lg bg-gradient-to-r from-cyan-500/25 to-purple-500/25 text-cyan-200 border border-cyan-400/50 font-mono text-[11px] font-bold tracking-wider">
                    CARD #${numFormatado} • RESPOSTA OFICIAL
                  </span>
                  <span class="px-2.5 py-0.5 rounded-lg border font-mono text-[10px] ${srsAtualMeta.badgeClass}">
                    ${srsAtualMeta.label}
                  </span>
                </div>

                <div class="my-auto py-4 text-center space-y-2">
                  <p class="text-base sm:text-xl font-bold text-cyan-100 leading-relaxed">
                    ${escapeHtml(cardAtual.answer)}
                  </p>
                </div>

                <div class="flex items-center justify-center gap-2 text-[11px] font-mono text-cyan-300/80">
                  <span>Avalie sua retenção abaixo: [1] Errei • [2] Difícil • [3] Fácil</span>
                </div>
              </div>
            </div>
          </div>

          <!-- Navegação e Avaliação SRS -->
          <div class="flex flex-col sm:flex-row items-center justify-between gap-3 pt-1">
            <div class="flex items-center gap-2">
              <button
                type="button"
                data-fc-prev
                class="px-3.5 py-2 rounded-xl bg-black/50 hover:bg-white/10 border border-white/15 text-xs font-mono text-zinc-200 transition-colors cursor-pointer"
              >
                ← Anterior
              </button>
              <button
                type="button"
                data-fc-flip
                class="px-3.5 py-2 rounded-xl bg-violet-600/30 hover:bg-violet-600 border border-violet-500/40 text-xs font-mono text-violet-200 hover:text-white transition-colors cursor-pointer"
              >
                🔄 Virar
              </button>
              <button
                type="button"
                data-fc-next
                class="px-3.5 py-2 rounded-xl bg-black/50 hover:bg-white/10 border border-white/15 text-xs font-mono text-zinc-200 transition-colors cursor-pointer"
              >
                Próximo →
              </button>
            </div>

            <div class="flex items-center gap-2 flex-wrap justify-center">
              <button
                type="button"
                data-fc-rate="hard"
                class="px-3 py-2 rounded-xl bg-rose-500/20 hover:bg-rose-500/35 border border-rose-500/45 text-rose-200 text-xs font-mono font-bold transition-all cursor-pointer"
                title="Atalho: tecla 1"
              >
                [1] Errei 🔴
              </button>
              <button
                type="button"
                data-fc-rate="medium"
                class="px-3 py-2 rounded-xl bg-amber-500/20 hover:bg-amber-500/35 border border-amber-500/45 text-amber-200 text-xs font-mono font-bold transition-all cursor-pointer"
                title="Atalho: tecla 2"
              >
                [2] Difícil 🟡
              </button>
              <button
                type="button"
                data-fc-rate="easy"
                class="px-3 py-2 rounded-xl bg-emerald-500/20 hover:bg-emerald-500/35 border border-emerald-500/45 text-emerald-200 text-xs font-mono font-bold transition-all cursor-pointer"
                title="Atalho: tecla 3"
              >
                [3] Fácil 🟢
              </button>
            </div>
          </div>

          <div class="text-center text-[10px] font-mono text-zinc-500">
            Atalhos: <kbd class="px-1.5 py-0.5 rounded bg-black/50 border border-white/10">Espaço</kbd> Virar •
            <kbd class="px-1.5 py-0.5 rounded bg-black/50 border border-white/10">←</kbd> <kbd class="px-1.5 py-0.5 rounded bg-black/50 border border-white/10">→</kbd> Navegar •
            <kbd class="px-1.5 py-0.5 rounded bg-black/50 border border-white/10">1</kbd> <kbd class="px-1.5 py-0.5 rounded bg-black/50 border border-white/10">2</kbd> <kbd class="px-1.5 py-0.5 rounded bg-black/50 border border-white/10">3</kbd> Avaliar SRS
          </div>
        </div>
      `}
    `;
  }

  function flipCard() {
    if (state.filteredCards.length === 0) return;
    state.flipped = !state.flipped;
    const inner = bodyEl.querySelector("[data-fc-inner]");
    if (inner) {
      inner.style.transform = state.flipped ? "rotateY(180deg)" : "rotateY(0deg)";
    } else {
      renderDeck();
    }
  }

  function nextCard() {
    if (state.filteredCards.length === 0) return;
    state.currentIndex = (state.currentIndex + 1) % state.filteredCards.length;
    state.flipped = false;
    renderDeck();
  }

  function prevCard() {
    if (state.filteredCards.length === 0) return;
    state.currentIndex = (state.currentIndex - 1 + state.filteredCards.length) % state.filteredCards.length;
    state.flipped = false;
    renderDeck();
  }

  function rateCurrentAndAdvance(rating) {
    const atual = state.filteredCards[state.currentIndex];
    if (!atual) return;
    state.srsMap = salvarAvaliacaoFlashcard(aula.id, atual.id, rating);
    state.flipped = false;
    // Se estiver filtrado por outro status e o card sair do filtro, recomputar mantém índice válido; caso contrário avança para o próximo
    const eraUltimo = state.currentIndex >= state.filteredCards.length - 1;
    if (state.srsFilter === "all") {
      state.currentIndex = eraUltimo ? 0 : state.currentIndex + 1;
    }
    renderDeck();
  }

  // Delegação de eventos dentro do container do deck
  const onClick = (e) => {
    _lastInteractedDeckId = aula.id;

    const filterBtn = e.target.closest("[data-fc-filter]");
    if (filterBtn) {
      state.srsFilter = filterBtn.getAttribute("data-fc-filter") || "all";
      state.currentIndex = 0;
      state.flipped = false;
      renderDeck();
      return;
    }

    if (e.target.closest("[data-fc-clear-all]")) {
      state.srsFilter = "all";
      state.currentIndex = 0;
      state.flipped = false;
      renderDeck();
      return;
    }

    if (e.target.closest("[data-fc-shuffle]")) {
      state.cardsOrder = embaralharLista(state.cardsOrder);
      state.currentIndex = 0;
      state.flipped = false;
      renderDeck();
      return;
    }

    if (e.target.closest("[data-fc-toggle-view]")) {
      state.viewMode = state.viewMode === "grid" ? "card" : "grid";
      state.flipped = false;
      renderDeck();
      return;
    }

    if (e.target.closest("[data-fc-reset-srs]")) {
      limparProgressoFlashcards(aula.id);
      state.srsMap = {};
      state.srsFilter = "all";
      state.currentIndex = 0;
      state.flipped = false;
      renderDeck();
      return;
    }

    const gridRateBtn = e.target.closest("[data-fc-grid-rate]");
    if (gridRateBtn) {
      const cardId = gridRateBtn.getAttribute("data-card-id");
      const rating = gridRateBtn.getAttribute("data-fc-grid-rate");
      if (cardId && rating) {
        state.srsMap = salvarAvaliacaoFlashcard(aula.id, cardId, rating);
        renderDeck();
      }
      return;
    }

    const open3dBtn = e.target.closest("[data-fc-open-in-3d]");
    if (open3dBtn) {
      const idx = parseInt(open3dBtn.getAttribute("data-fc-open-in-3d"), 10);
      state.viewMode = "card";
      state.currentIndex = Number.isFinite(idx) ? idx : 0;
      state.flipped = false;
      renderDeck();
      return;
    }

    if (e.target.closest("[data-fc-stage]") || e.target.closest("[data-fc-flip]")) {
      flipCard();
      return;
    }

    if (e.target.closest("[data-fc-prev]")) {
      prevCard();
      return;
    }

    if (e.target.closest("[data-fc-next]")) {
      nextCard();
      return;
    }

    const rateBtn = e.target.closest("[data-fc-rate]");
    if (rateBtn) {
      rateCurrentAndAdvance(rateBtn.getAttribute("data-fc-rate"));
    }
  };

  const onMouseEnter = () => {
    _lastInteractedDeckId = aula.id;
  };

  bodyEl.addEventListener("click", onClick);
  rootSection.addEventListener("mouseenter", onMouseEnter);

  _lastInteractedDeckId = aula.id;
  renderDeck();

  const instance = {
    flipCard,
    nextCard,
    prevCard,
    rateCurrentAndAdvance,
    getState: () => state,
    destroy: () => {
      bodyEl.removeEventListener("click", onClick);
      rootSection.removeEventListener("mouseenter", onMouseEnter);
    }
  };

  _activeFlashcardsDecks.set(aula.id, instance);
  return instance;
}

export function destroyFlashcardsDeck(aulaId) {
  if (!aulaId) return;
  const inst = _activeFlashcardsDecks.get(aulaId);
  if (inst) {
    inst.destroy();
    _activeFlashcardsDecks.delete(aulaId);
  }
  if (_lastInteractedDeckId === aulaId) {
    _lastInteractedDeckId = null;
  }
}
