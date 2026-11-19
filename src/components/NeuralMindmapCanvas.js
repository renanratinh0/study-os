/**
 * Study OS V2 - Neural Mindmap Canvas Engine (Camada 6)
 * Rede de Sinapses Viva em <canvas> inspirada no Graph View do Obsidian:
 *  - Física de molas + repulsão (Force-Directed Graph)
 *  - Partículas sinápticas animadas viajando nas curvas Bézier
 *  - 3 modos de gravidade em tempo real: Obsidian, Fluxo Mental (Esq->Dir) e Órbita 360°
 *  - Drag & drop de neurônios (Mouse + Touch), Pan & Zoom infinito e Centralizar Câmera + Zoom Padrão
 *  - Efeito Spotlight no hover, duplo-clique para expandir/recolher ramo e controle global nível a nível
 */

import { escapeHtml } from "../utils/domHelpers.js";
import { normalizeMindmapTree } from "../utils/artifactsParser.js";

const BRANCH_COLORS = ["#00f0ff", "#a855f7", "#f97316", "#10b981"];
const ROOT_COLOR = "#38bdf8";
const DEFAULT_ZOOM = 1;

const _activeMindmapInstances = new Map();

function hexToRgba(hex, alpha = 1) {
  const clean = String(hex || "#00f0ff").replace("#", "");
  const full = clean.length === 3
    ? clean.split("").map(c => c + c).join("")
    : clean.padEnd(6, "0");
  const num = parseInt(full, 16);
  const r = (num >> 16) & 255;
  const g = (num >> 8) & 255;
  const b = num & 255;
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function quebrarTextoLabel(texto, maxChars = 26, maxLines = 2) {
  const palavras = String(texto || "").trim().split(/\s+/).filter(Boolean);
  if (palavras.length === 0) return [""];

  const linhas = [];
  let atual = "";

  for (const palavra of palavras) {
    const tentativa = atual ? `${atual} ${palavra}` : palavra;
    if (tentativa.length <= maxChars) {
      atual = tentativa;
    } else {
      if (atual) linhas.push(atual);
      atual = palavra;
      if (linhas.length >= maxLines) break;
    }
  }

  if (atual && linhas.length < maxLines) {
    linhas.push(atual);
  } else if (atual && linhas.length >= maxLines) {
    const ultima = linhas[maxLines - 1];
    linhas[maxLines - 1] = ultima.length > maxChars - 1
      ? `${ultima.slice(0, maxChars - 1)}…`
      : `${ultima}…`;
  }

  return linhas.map(l => (l.length > maxChars + 2 ? `${l.slice(0, maxChars)}…` : l));
}

function getNodeColor(node) {
  if (!node || node.level === 0 || node.branchIndex < 0) return ROOT_COLOR;
  return BRANCH_COLORS[node.branchIndex % BRANCH_COLORS.length];
}

function getNodeRadius(level) {
  if (level === 0) return 22;
  if (level === 1) return 14;
  if (level === 2) return 10;
  return 7.5;
}

/**
 * Calcula o conjunto de IDs visíveis a partir da raiz dado o conjunto de nós recolhidos.
 * @param {object} tree
 * @param {Set<string>} collapsedIds
 * @returns {{ visibleIds: Set<string>, maxVisibleDepth: number, hasCollapsedVisible: boolean }}
 */
export function calcularVisibilidadeArvore(tree, collapsedIds) {
  const visibleIds = new Set();
  let maxVisibleDepth = 0;
  let hasCollapsedVisible = false;

  if (!tree || !tree.root) {
    return { visibleIds, maxVisibleDepth, hasCollapsedVisible };
  }

  function visit(node) {
    visibleIds.add(node.id);
    if (node.level > maxVisibleDepth) {
      maxVisibleDepth = node.level;
    }
    if (collapsedIds.has(node.id) && node.hasChildren) {
      hasCollapsedVisible = true;
      return;
    }
    (node.children || []).forEach(visit);
  }

  visit(tree.root);
  return { visibleIds, maxVisibleDepth, hasCollapsedVisible };
}

/**
 * Recolhe globalmente um nível inteiro de baixo para cima:
 * primeiro esconde as folhas, depois seus pais, e assim por diante até restar somente o nó raiz.
 * @param {object} tree
 * @param {Set<string>} collapsedIds
 * @returns {boolean} True se houve alteração
 */
export function recolherUmNivelGlobal(tree, collapsedIds) {
  if (!tree || !tree.root) return false;
  const { maxVisibleDepth } = calcularVisibilidadeArvore(tree, collapsedIds);
  if (maxVisibleDepth <= 0) return false;

  const targetLevel = maxVisibleDepth - 1;
  let alterou = false;

  for (const node of tree.nodes || []) {
    if (node.level === targetLevel && node.hasChildren && !collapsedIds.has(node.id)) {
      collapsedIds.add(node.id);
      alterou = true;
    }
  }

  return alterou;
}

/**
 * Expande globalmente um nível inteiro de cima para baixo (caminho inverso):
 * partindo do pai (raiz), libera os ramos nível por nível até exibir todas as folhas.
 * @param {object} tree
 * @param {Set<string>} collapsedIds
 * @returns {boolean} True se houve alteração
 */
export function expandirUmNivelGlobal(tree, collapsedIds) {
  if (!tree || !tree.root) return false;
  const { visibleIds } = calcularVisibilidadeArvore(tree, collapsedIds);

  let minCollapsedLevel = Infinity;
  for (const id of visibleIds) {
    const node = tree.nodeMap[id];
    if (node && node.hasChildren && collapsedIds.has(id)) {
      if (node.level < minCollapsedLevel) {
        minCollapsedLevel = node.level;
      }
    }
  }

  if (!Number.isFinite(minCollapsedLevel)) return false;

  let alterou = false;
  for (const id of visibleIds) {
    const node = tree.nodeMap[id];
    if (node && node.level === minCollapsedLevel && collapsedIds.has(id)) {
      collapsedIds.delete(id);
      alterou = true;
    }
  }

  return alterou;
}

/**
 * Renderiza o HTML estrutural da Camada 6 (Mapa Mental Neural).
 * @param {object} aula
 * @param {object} descriptor
 * @returns {string}
 */
export function renderMindmapSectionHtml(aula, descriptor) {
  if (!descriptor || !descriptor.existe) return "";
  const idBase = escapeHtml(aula.id);

  return `
    <section
      id="section-mindmap-${idBase}"
      data-mindmap-root="${idBase}"
      class="rounded-2xl bg-[#090c14] border border-cyan-500/35 shadow-2xl overflow-hidden text-zinc-100 keep-dark-theme"
    >
      <!-- Cabeçalho da Seção -->
      <div class="px-4 py-3.5 border-b border-cyan-500/20 bg-gradient-to-r from-[#0b1120] via-[#090c14] to-[#130d24] flex flex-col xl:flex-row xl:items-center justify-between gap-3">
        <div class="flex items-center gap-2.5 flex-wrap min-w-0">
          <span class="px-2.5 py-1 rounded-lg bg-cyan-500/15 text-cyan-300 border border-cyan-500/35 font-mono text-[11px] font-bold uppercase tracking-wider flex items-center gap-1.5">
            <span>🧠 6. Mapa Mental Neural</span>
            <span class="text-cyan-400/70 font-normal">(./mapa-mental.json)</span>
          </span>
          <span data-mindmap-stats class="text-[11px] font-mono text-zinc-400"></span>
        </div>

        <div class="flex items-center gap-2 flex-wrap">
          <!-- Seletor de Gravidade (3 modos) -->
          <div class="inline-flex items-center p-0.5 rounded-xl bg-black/50 border border-white/10 text-[11px] font-mono">
            <button
              type="button"
              data-gravity-btn="obsidian"
              class="px-2.5 py-1 rounded-lg bg-cyan-600 text-white font-semibold transition-all cursor-pointer"
              title="Grafo orgânico force-directed estilo Obsidian"
            >
              🕸️ Teia Obsidian
            </button>
            <button
              type="button"
              data-gravity-btn="mindmap"
              class="px-2.5 py-1 rounded-lg text-zinc-400 hover:text-white transition-all cursor-pointer"
              title="Organiza os níveis em colunas da esquerda para a direita com física elástica"
            >
              🌿 Fluxo Mental
            </button>
            <button
              type="button"
              data-gravity-btn="radial"
              class="px-2.5 py-1 rounded-lg text-zinc-400 hover:text-white transition-all cursor-pointer"
              title="Organiza os níveis em anéis concêntricos ao redor do núcleo central"
            >
              🪐 Órbita 360°
            </button>
          </div>

          <!-- Controle Global Nível a Nível (Recolher das folhas à raiz / Expandir da raiz às folhas) -->
          <div class="inline-flex items-center rounded-xl bg-black/50 border border-white/10 font-mono text-[11px] overflow-hidden">
            <button
              type="button"
              data-mindmap-collapse-level
              class="px-2.5 py-1 hover:bg-white/10 disabled:opacity-35 disabled:cursor-not-allowed text-zinc-200 hover:text-white transition-colors cursor-pointer"
              title="Recolher um nível inteiro (das folhas até sobrar só o nó pai)"
            >
              ➖ Recolher Nível
            </button>
            <span
              data-mindmap-depth-label
              class="px-2 py-1 text-cyan-300 border-x border-white/10 select-none"
              title="Profundidade atualmente visível"
            >
              Nível —
            </span>
            <button
              type="button"
              data-mindmap-expand-level
              class="px-2.5 py-1 hover:bg-white/10 disabled:opacity-35 disabled:cursor-not-allowed text-zinc-200 hover:text-white transition-colors cursor-pointer"
              title="Expandir um nível inteiro (da raiz até as folhas)"
            >
              ➕ Expandir Nível
            </button>
          </div>

          <!-- Controles de Zoom + Centralizar Câmera -->
          <div class="inline-flex items-center rounded-xl bg-black/50 border border-white/10 font-mono text-xs overflow-hidden">
            <button type="button" data-zoom-action="out" class="px-2.5 py-1 hover:bg-white/10 text-zinc-300 hover:text-white cursor-pointer" title="Diminuir zoom">−</button>
            <button type="button" data-zoom-action="default" class="px-2.5 py-1 hover:bg-white/10 text-cyan-300 border-x border-white/10 cursor-pointer" title="Restaurar zoom padrão (100%)">100%</button>
            <button type="button" data-zoom-action="in" class="px-2.5 py-1 hover:bg-white/10 text-zinc-300 hover:text-white cursor-pointer" title="Aumentar zoom">+</button>
          </div>

          <button
            type="button"
            data-mindmap-center
            class="px-2.5 py-1 rounded-xl bg-cyan-500/15 hover:bg-cyan-500/30 border border-cyan-500/35 text-cyan-200 hover:text-white font-mono text-[11px] font-semibold transition-colors cursor-pointer"
            title="Centralizar câmera e restaurar zoom padrão (100%)"
          >
            🎯 Centralizar
          </button>
        </div>
      </div>

      <!-- Palco Canvas -->
      <div class="relative w-full h-[460px] sm:h-[540px] bg-[#06080f] select-none overflow-hidden">
        <canvas
          data-mindmap-canvas="${idBase}"
          class="w-full h-full block cursor-grab active:cursor-grabbing"
          style="touch-action: none;"
        ></canvas>

        <!-- Estado vazio / carregando -->
        <div data-mindmap-empty class="hidden absolute inset-0 flex flex-col items-center justify-center p-6 text-center bg-[#06080f]/95">
          <div class="text-3xl mb-2">🧠</div>
          <div class="text-xs font-mono text-cyan-300 font-bold">Mapa Mental aguardando dados JSON</div>
          <p class="text-[11px] text-zinc-400 mt-1 max-w-md">
            Vincule sua pasta local na barra lateral para visualizar a rede neural interativa.
          </p>
        </div>

        <!-- Dica de Interação HUD -->
        <div class="pointer-events-none absolute top-3 left-3 flex flex-wrap items-center gap-1.5 text-[10px] font-mono text-zinc-400">
          <span class="px-2 py-0.5 rounded-md bg-black/70 border border-white/10 backdrop-blur-xs">✋ Arraste nós</span>
          <span class="px-2 py-0.5 rounded-md bg-black/70 border border-white/10 backdrop-blur-xs">🖱️ Fundo move câmera</span>
          <span class="px-2 py-0.5 rounded-md bg-black/70 border border-white/10 backdrop-blur-xs">⚡ Duplo-clique recolhe ramo</span>
        </div>
      </div>

      <!-- Barra Inspetora Inferior -->
      <div
        data-mindmap-inspector
        class="px-4 py-3 border-t border-cyan-500/20 bg-[#0b0f1a] flex flex-col lg:flex-row lg:items-center justify-between gap-3 text-xs"
      >
        <div class="text-zinc-400 font-mono text-[11px] flex items-center gap-2">
          <span class="w-2 h-2 rounded-full bg-cyan-400 animate-pulse shrink-0"></span>
          <span>Passe o mouse para Spotlight sináptico • Clique em um neurônio para inspecionar sua cadeia.</span>
        </div>
      </div>
    </section>
  `;
}

/**
 * Monta e inicia a física, renderização e eventos interativos do Mapa Mental Neural em <canvas>.
 * @param {HTMLElement} containerEl
 * @param {object} aula
 * @param {object | string} rawJson
 */
export function mountNeuralMindmap(containerEl, aula, rawJson) {
  if (typeof document === "undefined" || !containerEl || !aula) return null;

  const rootSection = containerEl.querySelector(`[data-mindmap-root="${aula.id}"]`)
    || (containerEl.matches?.(`[data-mindmap-root="${aula.id}"]`) ? containerEl : null);
  if (!rootSection) return null;

  destroyNeuralMindmap(aula.id);

  const canvas = rootSection.querySelector("[data-mindmap-canvas]");
  const emptyOverlay = rootSection.querySelector("[data-mindmap-empty]");
  const statsEl = rootSection.querySelector("[data-mindmap-stats]");
  const inspectorEl = rootSection.querySelector("[data-mindmap-inspector]");
  const gravityBtns = rootSection.querySelectorAll("[data-gravity-btn]");
  const zoomBtns = rootSection.querySelectorAll("[data-zoom-action]");
  const centerBtn = rootSection.querySelector("[data-mindmap-center]");
  const collapseLevelBtn = rootSection.querySelector("[data-mindmap-collapse-level]");
  const expandLevelBtn = rootSection.querySelector("[data-mindmap-expand-level]");
  const depthLabelEl = rootSection.querySelector("[data-mindmap-depth-label]");

  if (!canvas) return null;

  const tree = normalizeMindmapTree(rawJson);
  if (!tree.root || tree.nodes.length === 0) {
    emptyOverlay?.classList.remove("hidden");
    return null;
  }
  emptyOverlay?.classList.add("hidden");

  if (statsEl) {
    statsEl.textContent = `${tree.totalNodes} neurônios • ${tree.maxDepth + 1} níveis`;
  }

  const ctx = canvas.getContext("2d");
  if (!ctx) return null;

  const state = {
    gravityMode: "obsidian", // 'obsidian' | 'mindmap' | 'radial'
    collapsedIds: new Set(),
    hoveredId: null,
    selectedId: tree.root.id,
    camX: 0,
    camY: 0,
    zoom: DEFAULT_ZOOM,
    width: canvas.clientWidth || 800,
    height: canvas.clientHeight || 500,
    dpr: Math.min(typeof window !== "undefined" ? (window.devicePixelRatio || 1) : 1, 2),
    draggingNodeId: null,
    panning: false,
    pointerDownPos: null,
    lastPointerPos: null,
    pointerMovedDist: 0,
    lastTapInfo: { nodeId: null, time: 0 },
    simNodes: new Map(),
    visibleEdges: [],
    visibleIds: new Set(),
    maxVisibleDepth: tree.maxDepth,
    hasCollapsedVisible: false,
    particles: new Map(),
    rafId: null,
    resizeObserver: null,
    destroyed: false
  };

  function inicializarPosicoesIniciais() {
    function seed(node, angleStart, angleEnd, x, y) {
      state.simNodes.set(node.id, {
        node,
        x,
        y,
        vx: 0,
        vy: 0,
        tx: x,
        ty: y,
        hiddenCount: 0
      });

      const children = node.children || [];
      if (children.length === 0) return;

      const totalLeaves = children.reduce((acc, c) => acc + c.leafCount, 0) || children.length;
      let cursor = angleStart;
      const dist = node.level === 0 ? 185 : (node.level === 1 ? 145 : 115);

      children.forEach(child => {
        const share = ((child.leafCount || 1) / totalLeaves) * (angleEnd - angleStart);
        const midAngle = cursor + share / 2;
        seed(
          child,
          cursor,
          cursor + share,
          x + Math.cos(midAngle) * dist,
          y + Math.sin(midAngle) * dist
        );
        cursor += share;
      });
    }

    seed(tree.root, 0, Math.PI * 2, 0, 0);

    tree.edges.forEach((e, idx) => {
      state.particles.set(e.id, [
        (idx * 0.23) % 1,
        (idx * 0.23 + 0.5) % 1
      ]);
    });
  }

  function atualizarControlesNivel() {
    if (depthLabelEl) {
      depthLabelEl.textContent = `Nível ${state.maxVisibleDepth}/${tree.maxDepth}`;
    }
    if (collapseLevelBtn) {
      collapseLevelBtn.disabled = state.maxVisibleDepth <= 0;
    }
    if (expandLevelBtn) {
      expandLevelBtn.disabled = !state.hasCollapsedVisible;
    }
  }

  function recomputarVisibilidadeETargets() {
    const visibleIds = new Set();
    const visibleEdges = [];
    const visibleChildrenMap = new Map();
    const visibleLeafCounts = new Map();
    let maxVisibleDepth = 0;
    let hasCollapsedVisible = false;

    function collectVisible(node) {
      visibleIds.add(node.id);
      if (node.level > maxVisibleDepth) {
        maxVisibleDepth = node.level;
      }

      const collapsed = state.collapsedIds.has(node.id) && node.hasChildren;
      if (collapsed) hasCollapsedVisible = true;

      const sim = state.simNodes.get(node.id);
      if (sim) {
        sim.hiddenCount = collapsed ? node.descendantIds.length : 0;
      }

      if (collapsed || !node.children || node.children.length === 0) {
        visibleChildrenMap.set(node.id, []);
        visibleLeafCounts.set(node.id, 1);
        return 1;
      }

      const visChildren = [];
      let leaves = 0;
      node.children.forEach(child => {
        visChildren.push(child);
        visibleEdges.push({
          id: `${node.id}->${child.id}`,
          sourceId: node.id,
          targetId: child.id,
          branchIndex: child.branchIndex
        });
        leaves += collectVisible(child);
      });

      visibleChildrenMap.set(node.id, visChildren);
      visibleLeafCounts.set(node.id, Math.max(1, leaves));
      return leaves;
    }

    collectVisible(tree.root);
    state.visibleEdges = visibleEdges;
    state.visibleIds = visibleIds;
    state.maxVisibleDepth = maxVisibleDepth;
    state.hasCollapsedVisible = hasCollapsedVisible;
    atualizarControlesNivel();

    // Targets para modo 🌿 Fluxo Mental (Esquerda -> Direita com margem vertical generosa)
    if (state.gravityMode === "mindmap") {
      const COL_GAP = 290;
      const LEAF_ROW_HEIGHT = 76;
      const BRANCH_EXTRA_GAP = 26;

      const totalLeaves = visibleLeafCounts.get(tree.root.id) || 1;
      const topBranches = visibleChildrenMap.get(tree.root.id) || [];
      const totalExtraGap = Math.max(0, topBranches.length - 1) * BRANCH_EXTRA_GAP;
      const totalHeight = (totalLeaves - 1) * LEAF_ROW_HEIGHT + totalExtraGap;
      const rootX = -Math.max(180, (tree.maxDepth * COL_GAP) / 2);

      let cursorY = -totalHeight / 2;

      function assignMindmapTargets(node) {
        const visChildren = visibleChildrenMap.get(node.id) || [];
        const sim = state.simNodes.get(node.id);
        const tx = rootX + node.level * COL_GAP;

        if (visChildren.length === 0) {
          const ty = cursorY;
          cursorY += LEAF_ROW_HEIGHT;
          if (sim) {
            sim.tx = tx;
            sim.ty = ty;
          }
          return ty;
        }

        const childYs = [];
        visChildren.forEach((child, idx) => {
          const extra = node.level === 0 && idx > 0 ? BRANCH_EXTRA_GAP : 0;
          if (extra > 0) cursorY += extra;
          childYs.push(assignMindmapTargets(child));
        });

        const ty = (childYs[0] + childYs[childYs.length - 1]) / 2;
        if (sim) {
          sim.tx = tx;
          sim.ty = ty;
        }
        return ty;
      }

      assignMindmapTargets(tree.root);
    }

    // Targets para modo 🪐 Órbita 360° (Anéis concêntricos)
    if (state.gravityMode === "radial") {
      function assignRadialTargets(node, aStart, aEnd) {
        const sim = state.simNodes.get(node.id);
        const radius = node.level === 0 ? 0 : (node.level === 1 ? 185 : (node.level === 2 ? 360 : 520));
        const angle = (aStart + aEnd) / 2;
        if (sim) {
          sim.tx = Math.cos(angle) * radius;
          sim.ty = Math.sin(angle) * radius;
        }

        const visChildren = visibleChildrenMap.get(node.id) || [];
        if (visChildren.length === 0) return;

        const sumLeaves = visChildren.reduce((acc, c) => acc + (visibleLeafCounts.get(c.id) || 1), 0) || 1;
        let cur = aStart;
        visChildren.forEach(c => {
          const span = ((visibleLeafCounts.get(c.id) || 1) / sumLeaves) * (aEnd - aStart);
          assignRadialTargets(c, cur, cur + span);
          cur += span;
        });
      }
      assignRadialTargets(tree.root, -Math.PI, Math.PI);
    }
  }

  function atualizarBotaoZoomDefault() {
    const defaultBtn = rootSection.querySelector('[data-zoom-action="default"]');
    if (defaultBtn) {
      defaultBtn.textContent = `${Math.round(state.zoom * 100)}%`;
    }
  }

  function obterCentroVisivelMundo() {
    if (!state.visibleIds || state.visibleIds.size === 0) {
      return { cx: 0, cy: 0 };
    }
    if (state.gravityMode !== "mindmap") {
      const rootSim = state.simNodes.get(tree.root.id);
      return rootSim ? { cx: rootSim.x, cy: rootSim.y } : { cx: 0, cy: 0 };
    }

    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const id of state.visibleIds) {
      const sim = state.simNodes.get(id);
      if (!sim) continue;
      if (sim.x < minX) minX = sim.x;
      if (sim.x > maxX) maxX = sim.x;
      if (sim.y < minY) minY = sim.y;
      if (sim.y > maxY) maxY = sim.y;
    }
    if (!Number.isFinite(minX)) return { cx: 0, cy: 0 };
    return { cx: (minX + maxX) / 2, cy: (minY + maxY) / 2 };
  }

  /**
   * Centraliza a câmera no grafo visível e restaura o zoom padrão (100%).
   */
  function centralizarCamera(zoomPadrao = DEFAULT_ZOOM) {
    const { cx, cy } = obterCentroVisivelMundo();
    state.camX = cx;
    state.camY = cy;
    state.zoom = Math.max(0.25, Math.min(2.8, zoomPadrao));
    atualizarBotaoZoomDefault();
  }

  function autoFitCamera() {
    if (!state.visibleIds || state.visibleIds.size === 0) return;
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const id of state.visibleIds) {
      const sim = state.simNodes.get(id);
      if (!sim) continue;
      const refX = state.gravityMode === "obsidian" ? sim.x : sim.tx;
      const refY = state.gravityMode === "obsidian" ? sim.y : sim.ty;
      if (refX < minX) minX = refX;
      if (refX > maxX) maxX = refX;
      if (refY < minY) minY = refY;
      if (refY > maxY) maxY = refY;
    }

    const spanW = Math.max(260, maxX - minX + 260);
    const spanH = Math.max(240, maxY - minY + 140);
    const fitZoom = Math.min(state.width / spanW, state.height / spanH, 1.05);
    state.zoom = Math.max(0.32, Math.min(1.15, fitZoom));
    state.camX = (minX + maxX) / 2;
    state.camY = (minY + maxY) / 2;
    atualizarBotaoZoomDefault();
  }

  function resizeCanvas() {
    const rect = canvas.getBoundingClientRect();
    const w = Math.max(300, Math.round(rect.width || canvas.clientWidth || 720));
    const h = Math.max(360, Math.round(rect.height || canvas.clientHeight || 480));
    state.width = w;
    state.height = h;
    state.dpr = Math.min(typeof window !== "undefined" ? (window.devicePixelRatio || 1) : 1, 2);
    canvas.width = Math.round(w * state.dpr);
    canvas.height = Math.round(h * state.dpr);
  }

  function screenToWorld(sx, sy) {
    return {
      x: (sx - state.width / 2) / state.zoom + state.camX,
      y: (sy - state.height / 2) / state.zoom + state.camY
    };
  }

  function findNodeAtWorld(wx, wy) {
    let best = null;
    let bestDist = Infinity;
    for (const id of state.visibleIds || []) {
      const sim = state.simNodes.get(id);
      if (!sim) continue;
      const r = getNodeRadius(sim.node.level) + 12 / state.zoom;
      const dx = wx - sim.x;
      const dy = wy - sim.y;
      const d = Math.hypot(dx, dy);
      if (d <= r && d < bestDist) {
        best = sim;
        bestDist = d;
      }
    }
    return best;
  }

  function getSpotlightSet(nodeId) {
    if (!nodeId) return null;
    const node = tree.nodeMap[nodeId];
    if (!node) return null;
    const set = new Set([nodeId, ...(node.ancestorIds || [])]);
    function addVisDesc(n) {
      if (!state.visibleIds?.has(n.id)) return;
      set.add(n.id);
      if (state.collapsedIds.has(n.id)) return;
      (n.children || []).forEach(addVisDesc);
    }
    addVisDesc(node);
    return set;
  }

  function getEdgeControlPoints(src, dst) {
    if (state.gravityMode === "mindmap") {
      const dx = (dst.x - src.x) * 0.52;
      return {
        cp1x: src.x + dx,
        cp1y: src.y,
        cp2x: dst.x - dx,
        cp2y: dst.y
      };
    }

    const mx = (src.x + dst.x) / 2;
    const my = (src.y + dst.y) / 2;
    const dx = dst.x - src.x;
    const dy = dst.y - src.y;
    const len = Math.hypot(dx, dy) || 1;
    const curveAmp = Math.min(28, len * 0.14);
    const nx = -dy / len;
    const ny = dx / len;
    const sign = (dst.node.branchIndex % 2 === 0 ? 1 : -1);
    const cx = mx + nx * curveAmp * sign;
    const cy = my + ny * curveAmp * sign;

    return {
      cp1x: cx,
      cp1y: cy,
      cp2x: cx,
      cp2y: cy
    };
  }

  function evalCubicBezier(p0x, p0y, cp1x, cp1y, cp2x, cp2y, p1x, p1y, t) {
    const mt = 1 - t;
    const mt2 = mt * mt;
    const t2 = t * t;
    const a = mt2 * mt;
    const b = 3 * mt2 * t;
    const c = 3 * mt * t2;
    const d = t2 * t;
    return {
      x: a * p0x + b * cp1x + c * cp2x + d * p1x,
      y: a * p0y + b * cp1y + c * cp2y + d * p1y
    };
  }

  function stepPhysics() {
    const visibleArr = [];
    for (const id of state.visibleIds || []) {
      const sim = state.simNodes.get(id);
      if (sim) visibleArr.push(sim);
    }

    const nCount = visibleArr.length;
    const repulsionStrength = state.gravityMode === "obsidian" ? 4400 : 1800;

    for (let i = 0; i < nCount; i++) {
      const a = visibleArr[i];
      for (let j = i + 1; j < nCount; j++) {
        const b = visibleArr[j];
        let dx = b.x - a.x;
        let dy = b.y - a.y;
        let distSq = dx * dx + dy * dy;
        if (distSq < 16) {
          dx = (Math.random() - 0.5) * 4;
          dy = (Math.random() - 0.5) * 4;
          distSq = 16;
        }
        if (distSq > 110000) continue;
        const dist = Math.sqrt(distSq);
        const force = repulsionStrength / distSq;
        const fx = (dx / dist) * force;
        const fy = (dy / dist) * force;

        if (a.node.id !== state.draggingNodeId && !(state.gravityMode !== "mindmap" && a.node.level === 0)) {
          a.vx -= fx;
          a.vy -= fy;
        }
        if (b.node.id !== state.draggingNodeId && !(state.gravityMode !== "mindmap" && b.node.level === 0)) {
          b.vx += fx;
          b.vy += fy;
        }
      }
    }

    const springK = state.gravityMode === "obsidian" ? 0.048 : 0.025;
    for (const edge of state.visibleEdges) {
      const src = state.simNodes.get(edge.sourceId);
      const dst = state.simNodes.get(edge.targetId);
      if (!src || !dst) continue;

      const restLen = state.gravityMode === "obsidian"
        ? (src.node.level === 0 ? 165 : (src.node.level === 1 ? 125 : 95))
        : Math.max(90, Math.hypot(dst.tx - src.tx, dst.ty - src.ty));

      const dx = dst.x - src.x;
      const dy = dst.y - src.y;
      const dist = Math.hypot(dx, dy) || 1;
      const displacement = dist - restLen;
      const f = displacement * springK;
      const fx = (dx / dist) * f;
      const fy = (dy / dist) * f;

      if (src.node.id !== state.draggingNodeId && !(state.gravityMode !== "mindmap" && src.node.level === 0)) {
        src.vx += fx * 0.45;
        src.vy += fy * 0.45;
      }
      if (dst.node.id !== state.draggingNodeId) {
        dst.vx -= fx;
        dst.vy -= fy;
      }
    }

    for (const sim of visibleArr) {
      const isRoot = sim.node.level === 0;
      const isDragged = sim.node.id === state.draggingNodeId;

      if (isDragged) {
        sim.vx = 0;
        sim.vy = 0;
        continue;
      }

      if (state.gravityMode === "obsidian") {
        if (isRoot) {
          sim.vx += (0 - sim.x) * 0.25;
          sim.vy += (0 - sim.y) * 0.25;
        } else {
          const targetR = sim.node.level * 155;
          const curR = Math.hypot(sim.x, sim.y) || 1;
          const radialDelta = targetR - curR;
          sim.vx += (sim.x / curR) * radialDelta * 0.012 - sim.x * 0.002;
          sim.vy += (sim.y / curR) * radialDelta * 0.012 - sim.y * 0.002;
        }
      } else {
        const pull = isRoot ? 0.22 : (state.gravityMode === "mindmap" ? 0.13 : 0.11);
        sim.vx += (sim.tx - sim.x) * pull;
        sim.vy += (sim.ty - sim.y) * pull;
      }

      sim.vx *= 0.80;
      sim.vy *= 0.80;

      const maxVel = 28;
      const vel = Math.hypot(sim.vx, sim.vy);
      if (vel > maxVel) {
        sim.vx = (sim.vx / vel) * maxVel;
        sim.vy = (sim.vy / vel) * maxVel;
      }

      sim.x += sim.vx;
      sim.y += sim.vy;
    }

    for (const edge of state.visibleEdges) {
      const arr = state.particles.get(edge.id);
      if (!arr) continue;
      arr[0] = (arr[0] + 0.0065) % 1;
      arr[1] = (arr[1] + 0.0065) % 1;
    }
  }

  function drawFrame() {
    if (state.destroyed) return;

    stepPhysics();

    ctx.save();
    ctx.setTransform(state.dpr, 0, 0, state.dpr, 0, 0);

    ctx.fillStyle = "#06080f";
    ctx.fillRect(0, 0, state.width, state.height);

    const gridSpacing = 44 * state.zoom;
    if (gridSpacing >= 14) {
      const offsetX = ((state.width / 2 - state.camX * state.zoom) % gridSpacing + gridSpacing) % gridSpacing;
      const offsetY = ((state.height / 2 - state.camY * state.zoom) % gridSpacing + gridSpacing) % gridSpacing;
      ctx.fillStyle = "rgba(56, 189, 248, 0.08)";
      for (let gx = offsetX; gx < state.width; gx += gridSpacing) {
        for (let gy = offsetY; gy < state.height; gy += gridSpacing) {
          ctx.fillRect(gx - 0.75, gy - 0.75, 1.5, 1.5);
        }
      }
    }

    ctx.translate(state.width / 2, state.height / 2);
    ctx.scale(state.zoom, state.zoom);
    ctx.translate(-state.camX, -state.camY);

    if (state.gravityMode === "radial") {
      ctx.save();
      ctx.setLineDash([5, 7]);
      ctx.lineWidth = 1 / state.zoom;
      [185, 360, 520].forEach((r, idx) => {
        ctx.strokeStyle = `rgba(56, 189, 248, ${0.14 - idx * 0.03})`;
        ctx.beginPath();
        ctx.arc(0, 0, r, 0, Math.PI * 2);
        ctx.stroke();
      });
      ctx.restore();
    }

    const spotlightSet = state.hoveredId ? getSpotlightSet(state.hoveredId) : null;

    for (const edge of state.visibleEdges) {
      const src = state.simNodes.get(edge.sourceId);
      const dst = state.simNodes.get(edge.targetId);
      if (!src || !dst) continue;

      const highlighted = !spotlightSet || (spotlightSet.has(edge.sourceId) && spotlightSet.has(edge.targetId));
      const baseAlpha = highlighted ? 0.72 : 0.14;
      const color = getNodeColor(dst.node);
      const { cp1x, cp1y, cp2x, cp2y } = getEdgeControlPoints(src, dst);

      ctx.save();
      ctx.beginPath();
      ctx.moveTo(src.x, src.y);
      ctx.bezierCurveTo(cp1x, cp1y, cp2x, cp2y, dst.x, dst.y);
      ctx.strokeStyle = hexToRgba(color, baseAlpha);
      ctx.lineWidth = highlighted ? 2.1 : 1.1;
      ctx.stroke();

      if (highlighted) {
        const ts = state.particles.get(edge.id) || [0.25, 0.75];
        ts.forEach(t => {
          const pt = evalCubicBezier(src.x, src.y, cp1x, cp1y, cp2x, cp2y, dst.x, dst.y, t);
          ctx.beginPath();
          ctx.arc(pt.x, pt.y, 4.5, 0, Math.PI * 2);
          ctx.fillStyle = hexToRgba(color, 0.35);
          ctx.fill();

          ctx.beginPath();
          ctx.arc(pt.x, pt.y, 2, 0, Math.PI * 2);
          ctx.fillStyle = "#ffffff";
          ctx.fill();
        });
      }
      ctx.restore();
    }

    for (const id of state.visibleIds || []) {
      const sim = state.simNodes.get(id);
      if (!sim) continue;

      const { node, x, y, hiddenCount } = sim;
      const isRoot = node.level === 0;
      const isSelected = node.id === state.selectedId;
      const isHovered = node.id === state.hoveredId;
      const isCollapsed = state.collapsedIds.has(node.id) && node.hasChildren;
      const inSpotlight = !spotlightSet || spotlightSet.has(node.id);
      const nodeAlpha = inSpotlight ? 1 : 0.2;
      const color = getNodeColor(node);
      const radius = getNodeRadius(node.level);

      ctx.save();
      ctx.globalAlpha = nodeAlpha;

      if (isRoot || isSelected || isHovered) {
        const glowR = radius + (isRoot ? 14 : 9);
        const grad = ctx.createRadialGradient(x, y, radius * 0.3, x, y, glowR);
        grad.addColorStop(0, hexToRgba(color, isRoot ? 0.55 : 0.45));
        grad.addColorStop(1, hexToRgba(color, 0));
        ctx.beginPath();
        ctx.arc(x, y, glowR, 0, Math.PI * 2);
        ctx.fillStyle = grad;
        ctx.fill();
      }

      ctx.beginPath();
      ctx.arc(x, y, radius, 0, Math.PI * 2);
      ctx.fillStyle = isRoot ? "#0f172a" : "#0b0f1c";
      ctx.fill();
      ctx.lineWidth = isSelected ? 3 : (isRoot ? 2.8 : 2);
      ctx.strokeStyle = isSelected ? "#ffffff" : color;
      ctx.stroke();

      if (!isCollapsed) {
        ctx.beginPath();
        ctx.arc(x, y, isRoot ? 7 : (node.level === 1 ? 4.5 : 3), 0, Math.PI * 2);
        ctx.fillStyle = isRoot ? "#e0f2fe" : color;
        ctx.fill();
      } else {
        ctx.strokeStyle = "#ffffff";
        ctx.lineWidth = 2;
        const arm = Math.max(4, radius * 0.48);
        ctx.beginPath();
        ctx.moveTo(x - arm, y);
        ctx.lineTo(x + arm, y);
        ctx.moveTo(x, y - arm);
        ctx.lineTo(x, y + arm);
        ctx.stroke();

        if (hiddenCount > 0) {
          ctx.font = "bold 9px 'JetBrains Mono', monospace";
          ctx.fillStyle = color;
          ctx.textAlign = "left";
          ctx.textBaseline = "middle";
          ctx.fillText(`+${hiddenCount}`, x + radius + 4, y - radius + 2);
        }
      }

      const mostrarLabel = state.zoom >= 0.42 || isRoot || node.level <= 1 || isHovered || isSelected;
      if (mostrarLabel) {
        const fontSize = isRoot ? 12.5 : (node.level === 1 ? 11 : 10);
        ctx.font = `${isRoot || node.level === 1 ? "600 " : "500 "}${fontSize}px 'Inter', sans-serif`;
        const linhas = quebrarTextoLabel(node.name, isRoot ? 30 : 25, 2);
        const lineHeight = fontSize + 3.5;
        const maxLineW = Math.max(...linhas.map(l => ctx.measureText(l).width));
        const padX = 7;
        const padY = 4;
        const boxW = maxLineW + padX * 2;
        const boxH = linhas.length * lineHeight + padY * 2;

        const boxX = x - boxW / 2;
        const boxY = y + radius + 6;

        ctx.fillStyle = "rgba(9, 12, 22, 0.88)";
        ctx.strokeStyle = hexToRgba(color, isSelected || isHovered ? 0.85 : 0.32);
        ctx.lineWidth = isSelected ? 1.4 : 1;

        ctx.beginPath();
        if (typeof ctx.roundRect === "function") {
          ctx.roundRect(boxX, boxY, boxW, boxH, 6);
        } else {
          ctx.rect(boxX, boxY, boxW, boxH);
        }
        ctx.fill();
        ctx.stroke();

        ctx.fillStyle = isRoot || isSelected || isHovered ? "#ffffff" : "#e4e4e7";
        ctx.textAlign = "center";
        ctx.textBaseline = "top";
        linhas.forEach((linha, idxL) => {
          ctx.fillText(linha, x, boxY + padY + idxL * lineHeight);
        });
      }

      ctx.restore();
    }

    ctx.restore();
    state.rafId = requestAnimationFrame(drawFrame);
  }

  function renderInspector(nodeId) {
    if (!inspectorEl) return;
    const node = tree.nodeMap[nodeId] || tree.root;
    if (!node) return;

    const color = getNodeColor(node);
    const ancestors = (node.ancestorIds || []).map(aid => tree.nodeMap[aid]).filter(Boolean);
    const breadcrumbNodes = [...ancestors, node];
    const isCollapsed = state.collapsedIds.has(node.id);

    inspectorEl.innerHTML = `
      <div class="flex flex-col gap-2 min-w-0 flex-1">
        <!-- Breadcrumb -->
        <div class="flex items-center gap-1.5 flex-wrap font-mono text-[11px]">
          <span class="text-zinc-500">Caminho:</span>
          ${breadcrumbNodes.map((bn, idx) => {
            const ehAtual = idx === breadcrumbNodes.length - 1;
            const sep = idx < breadcrumbNodes.length - 1 ? `<span class="text-zinc-600">➔</span>` : "";
            return `
              <button
                type="button"
                data-inspect-select="${escapeHtml(bn.id)}"
                class="px-2 py-0.5 rounded-md transition-colors cursor-pointer ${
                  ehAtual
                    ? "bg-white/10 text-white font-bold border border-white/20"
                    : "text-zinc-400 hover:text-cyan-300 hover:bg-white/5"
                }"
              >${escapeHtml(bn.name)}</button>
              ${sep}
            `;
          }).join("")}
        </div>

        <!-- Filhos Diretos -->
        <div class="flex items-center gap-1.5 flex-wrap text-[11px]">
          <span class="font-mono text-zinc-500 shrink-0">Filhos (${node.children.length}):</span>
          ${node.children.length > 0
            ? node.children.map(child => `
                <button
                  type="button"
                  data-inspect-select="${escapeHtml(child.id)}"
                  class="px-2 py-0.5 rounded-md bg-black/50 hover:bg-white/10 text-zinc-300 hover:text-white border transition-colors cursor-pointer font-mono text-[10px]"
                  style="border-color: ${hexToRgba(color, 0.4)}"
                >${escapeHtml(child.name)}</button>
              `).join("")
            : `<span class="text-zinc-500 italic font-mono text-[10px]">Nó folha (sem sub-ramos)</span>`
          }
        </div>
      </div>

      ${node.hasChildren ? `
        <div class="flex items-center gap-2 shrink-0 self-start lg:self-center flex-wrap">
          <button
            type="button"
            data-inspect-toggle-collapse="${escapeHtml(node.id)}"
            class="px-3 py-1.5 rounded-xl bg-black/50 hover:bg-white/10 text-zinc-200 border border-white/15 font-mono text-[11px] transition-colors cursor-pointer"
          >
            ${isCollapsed ? "➕ Expandir Ramo" : "➖ Recolher Ramo"}
          </button>
        </div>
      ` : ""}
    `;
  }

  function toggleCollapseNode(nodeId) {
    const node = tree.nodeMap[nodeId];
    if (!node || !node.hasChildren) return;
    if (state.collapsedIds.has(nodeId)) {
      state.collapsedIds.delete(nodeId);
    } else {
      state.collapsedIds.add(nodeId);
    }
    recomputarVisibilidadeETargets();
    renderInspector(state.selectedId);
  }

  function handleCollapseLevel() {
    if (recolherUmNivelGlobal(tree, state.collapsedIds)) {
      if (!state.visibleIds.has(state.selectedId)) {
        state.selectedId = tree.root.id;
      }
      recomputarVisibilidadeETargets();
      if (!state.visibleIds.has(state.selectedId)) {
        state.selectedId = tree.root.id;
      }
      renderInspector(state.selectedId);
    }
  }

  function handleExpandLevel() {
    if (expandirUmNivelGlobal(tree, state.collapsedIds)) {
      recomputarVisibilidadeETargets();
      renderInspector(state.selectedId);
    }
  }

  function setGravityMode(mode) {
    if (!["obsidian", "mindmap", "radial"].includes(mode)) return;
    state.gravityMode = mode;

    gravityBtns.forEach(btn => {
      const active = btn.getAttribute("data-gravity-btn") === mode;
      btn.className = active
        ? "px-2.5 py-1 rounded-lg bg-cyan-600 text-white font-semibold transition-all cursor-pointer"
        : "px-2.5 py-1 rounded-lg text-zinc-400 hover:text-white transition-all cursor-pointer";
    });

    recomputarVisibilidadeETargets();
    autoFitCamera();
  }

  // Eventos de UI
  gravityBtns.forEach(btn => {
    btn.addEventListener("click", () => {
      setGravityMode(btn.getAttribute("data-gravity-btn"));
    });
  });

  collapseLevelBtn?.addEventListener("click", handleCollapseLevel);
  expandLevelBtn?.addEventListener("click", handleExpandLevel);
  centerBtn?.addEventListener("click", () => centralizarCamera(DEFAULT_ZOOM));

  zoomBtns.forEach(btn => {
    btn.addEventListener("click", () => {
      const act = btn.getAttribute("data-zoom-action");
      if (act === "in") {
        state.zoom = Math.min(2.8, state.zoom * 1.2);
        atualizarBotaoZoomDefault();
      } else if (act === "out") {
        state.zoom = Math.max(0.25, state.zoom / 1.2);
        atualizarBotaoZoomDefault();
      } else {
        state.zoom = DEFAULT_ZOOM;
        atualizarBotaoZoomDefault();
      }
    });
  });

  inspectorEl?.addEventListener("click", (e) => {
    const btnSelect = e.target.closest("[data-inspect-select]");
    if (btnSelect) {
      const targetId = btnSelect.getAttribute("data-inspect-select");
      state.selectedId = targetId;
      renderInspector(targetId);
      const sim = state.simNodes.get(targetId);
      if (sim) {
        state.camX = sim.x;
        state.camY = sim.y;
      }
      return;
    }

    const btnCollapse = e.target.closest("[data-inspect-toggle-collapse]");
    if (btnCollapse) {
      toggleCollapseNode(btnCollapse.getAttribute("data-inspect-toggle-collapse"));
    }
  });

  const getCanvasCoords = (e) => {
    const rect = canvas.getBoundingClientRect();
    return { sx: e.clientX - rect.left, sy: e.clientY - rect.top };
  };

  canvas.addEventListener("pointerdown", (e) => {
    canvas.setPointerCapture?.(e.pointerId);
    const { sx, sy } = getCanvasCoords(e);
    const world = screenToWorld(sx, sy);
    const hit = findNodeAtWorld(world.x, world.y);

    state.pointerDownPos = { sx, sy };
    state.lastPointerPos = { sx, sy };
    state.pointerMovedDist = 0;

    if (hit) {
      state.draggingNodeId = hit.node.id;
      state.panning = false;
      canvas.style.cursor = "grabbing";
    } else {
      state.draggingNodeId = null;
      state.panning = true;
      canvas.style.cursor = "grabbing";
    }
  });

  canvas.addEventListener("pointermove", (e) => {
    const { sx, sy } = getCanvasCoords(e);
    const world = screenToWorld(sx, sy);

    if (state.lastPointerPos) {
      state.pointerMovedDist += Math.hypot(sx - state.lastPointerPos.sx, sy - state.lastPointerPos.sy);
    }

    if (state.draggingNodeId) {
      const sim = state.simNodes.get(state.draggingNodeId);
      if (sim) {
        sim.x = world.x;
        sim.y = world.y;
        sim.vx = 0;
        sim.vy = 0;
      }
    } else if (state.panning && state.lastPointerPos) {
      const dx = (sx - state.lastPointerPos.sx) / state.zoom;
      const dy = (sy - state.lastPointerPos.sy) / state.zoom;
      state.camX -= dx;
      state.camY -= dy;
    } else {
      const hit = findNodeAtWorld(world.x, world.y);
      state.hoveredId = hit ? hit.node.id : null;
      canvas.style.cursor = hit ? "pointer" : "grab";
    }

    state.lastPointerPos = { sx, sy };
  });

  const handlePointerEnd = (e) => {
    const { sx, sy } = getCanvasCoords(e);
    const world = screenToWorld(sx, sy);
    const foiCliqueSimples = state.pointerMovedDist < 6;

    if (foiCliqueSimples) {
      const hit = findNodeAtWorld(world.x, world.y);
      if (hit) {
        state.selectedId = hit.node.id;
        renderInspector(hit.node.id);

        const agora = Date.now();
        if (e.pointerType === "touch" && state.lastTapInfo.nodeId === hit.node.id && (agora - state.lastTapInfo.time) < 340) {
          toggleCollapseNode(hit.node.id);
          state.lastTapInfo = { nodeId: null, time: 0 };
        } else {
          state.lastTapInfo = { nodeId: hit.node.id, time: agora };
        }
      }
    }

    state.draggingNodeId = null;
    state.panning = false;
    state.lastPointerPos = null;
    canvas.style.cursor = state.hoveredId ? "pointer" : "grab";
  };

  canvas.addEventListener("pointerup", handlePointerEnd);
  canvas.addEventListener("pointercancel", handlePointerEnd);
  canvas.addEventListener("pointerleave", () => {
    if (!state.draggingNodeId && !state.panning) {
      state.hoveredId = null;
    }
  });

  canvas.addEventListener("dblclick", (e) => {
    const { sx, sy } = getCanvasCoords(e);
    const world = screenToWorld(sx, sy);
    const hit = findNodeAtWorld(world.x, world.y);
    if (hit && hit.node.hasChildren) {
      toggleCollapseNode(hit.node.id);
    }
  });

  canvas.addEventListener("wheel", (e) => {
    e.preventDefault();
    const { sx, sy } = getCanvasCoords(e);
    const before = screenToWorld(sx, sy);
    const factor = e.deltaY < 0 ? 1.12 : 1 / 1.12;
    const novoZoom = Math.max(0.25, Math.min(2.8, state.zoom * factor));
    state.zoom = novoZoom;
    state.camX = before.x - (sx - state.width / 2) / state.zoom;
    state.camY = before.y - (sy - state.height / 2) / state.zoom;
    atualizarBotaoZoomDefault();
  }, { passive: false });

  resizeCanvas();
  inicializarPosicoesIniciais();
  recomputarVisibilidadeETargets();
  autoFitCamera();
  renderInspector(state.selectedId);

  if (typeof ResizeObserver !== "undefined") {
    state.resizeObserver = new ResizeObserver(() => resizeCanvas());
    state.resizeObserver.observe(canvas);
  }

  state.rafId = requestAnimationFrame(drawFrame);

  const instance = {
    destroy: () => {
      state.destroyed = true;
      if (state.rafId) cancelAnimationFrame(state.rafId);
      state.resizeObserver?.disconnect();
    },
    setGravityMode,
    centralizarCamera,
    recolherUmNivel: handleCollapseLevel,
    expandirUmNivel: handleExpandLevel,
    getState: () => state
  };

  _activeMindmapInstances.set(aula.id, instance);
  return instance;
}

/**
 * Destrói e libera a animação e observadores do Mapa Mental ao fechar a aula.
 * @param {string} aulaId
 */
export function destroyNeuralMindmap(aulaId) {
  if (!aulaId) return;
  const inst = _activeMindmapInstances.get(aulaId);
  if (inst) {
    inst.destroy();
    _activeMindmapInstances.delete(aulaId);
  }
}

export function destroyAllNeuralMindmaps() {
  for (const id of _activeMindmapInstances.keys()) {
    destroyNeuralMindmap(id);
  }
}
