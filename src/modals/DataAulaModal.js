/**
 * Study OS V2 - DataAulaModal (Lazy Loaded via Dynamic Import)
 * Modal de controle de data, presença e revisão das aulas no Notion,
 * com prévia visual em tempo real e visualizador imersivo de detalhes da aula
 * com descarte de Blobs e desconexão de observadores para evitar vazamentos de memória.
 */

import { store, buscarRefDisciplina, buscarDisciplinaPorId, calcularStatusAula, verificarLinkNotebookDuplicado, extrairDriveIdDeLink } from "../core/store.js";
import { mostrarToast, extrairNumeroAula, obterTituloAula, escapeHtml } from "../utils/domHelpers.js";
import { enviarFilaEdicaoAulaData } from "../services/api.js";
import { montarConteudoInternoDaAula, hidratarArtefatosAula, desmontarArtefatosAula } from "../components/LessonAccordion.js";
import { observarMidiasLazy } from "../utils/performance.js";
import { revogarBlobsDaAula } from "../services/mediaResolver.js";
import { isAdminAutenticado } from "../services/auth.js";

/**
 * Atualiza o preview dos badges de presença, falta, agendamento e revisão dentro do modal.
 */
export function atualizarPreviewStatusModalAula() {
  if (typeof document === "undefined") return;

  const dataVal = document.getElementById("form-aula-data")?.value || "";
  const presVal = Boolean(document.getElementById("form-aula-presenca")?.checked);
  const revVal = Boolean(document.getElementById("form-aula-revisao")?.checked);
  const container = document.getElementById("modal-aula-preview-status");
  if (!container) return;

  const st = calcularStatusAula({ data_aula: dataVal, presenca: presVal, revisao: revVal });
  let html = "";
  if (st.presenca) {
    html += `<span class="px-2 py-0.5 rounded-full text-[10px] font-mono bg-emerald-500/20 text-emerald-300 border border-emerald-500/40">✅ Presente</span> `;
  } else if (st.falta) {
    html += `<span class="px-2 py-0.5 rounded-full text-[10px] font-mono bg-rose-500/20 text-rose-300 border border-rose-500/40 font-bold">🟥 Falta</span> `;
  } else if (st.temData) {
    html += `<span class="px-2 py-0.5 rounded-full text-[10px] font-mono bg-cyan-500/20 text-cyan-300 border border-cyan-500/40">📅 Agendada</span> `;
  } else {
    html += `<span class="px-2 py-0.5 rounded-full text-[10px] font-mono bg-notion-sidebar text-notion-muted border border-notion-border">📅 Sem data</span> `;
  }
  if (st.revisao) {
    html += `<span class="px-2 py-0.5 rounded-full text-[10px] font-mono bg-purple-500/20 text-purple-300 border border-purple-500/40">🆗 Revisada</span>`;
  }
  container.innerHTML = html;
}

/**
 * Atualiza o preview dos links de Google Drive e NotebookLM,
 * auditando duplicidade de caderno interativo em tempo real.
 */
export function atualizarPreviewLinksAula() {
  if (typeof document === "undefined") return;

  const driveInput = document.getElementById("form-aula-link-drive");
  const driveBtn = document.getElementById("form-aula-link-drive-btn");
  const notebookInput = document.getElementById("form-aula-link-notebook");
  const notebookBtn = document.getElementById("form-aula-link-notebook-btn");
  const notebookAviso = document.getElementById("form-aula-notebook-aviso");

  const driveVal = (driveInput?.value || "").trim();
  const nbVal = (notebookInput?.value || "").trim();

  // 1. Botão Abrir no Google Drive
  if (driveBtn) {
    if (driveVal && /^https?:\/\//i.test(driveVal)) {
      driveBtn.href = driveVal;
      driveBtn.classList.remove("hidden");
    } else {
      driveBtn.classList.add("hidden");
    }
  }

  // 2. Botão Abrir NotebookLM
  if (notebookBtn) {
    if (nbVal && /^https?:\/\//i.test(nbVal)) {
      notebookBtn.href = nbVal;
      notebookBtn.classList.remove("hidden");
    } else {
      notebookBtn.classList.add("hidden");
    }
  }

  // 3. Validador em Tempo Real de Links Duplicados do NotebookLM
  if (notebookAviso) {
    if (!nbVal) {
      notebookAviso.classList.add("hidden");
      notebookAviso.innerHTML = "";
      if (notebookInput) {
        notebookInput.classList.remove("border-amber-500", "focus:border-amber-500", "border-emerald-500/60");
        notebookInput.classList.add("border-notion-border", "focus:border-indigo-500");
      }
      return;
    }

    const state = store.getState();
    const disc = state.disciplinaModalDataAula;
    const aula = state.aulaModalDataAula;
    const checagem = verificarLinkNotebookDuplicado(nbVal, disc?.id, aula?.id);

    if (checagem.duplicado) {
      notebookAviso.classList.remove("hidden");
      notebookAviso.innerHTML = `
        <div class="p-2.5 rounded-xl bg-amber-500/15 border border-amber-500/40 text-amber-200 space-y-1">
          <div class="font-bold flex items-center gap-1.5 text-amber-300">
            <span>⚠️ Atenção: Caderno NotebookLM já vinculado em outra aula!</span>
          </div>
          <div class="text-[11px] opacity-90">Este mesmo link já está cadastrado em:</div>
          <ul class="list-disc list-inside font-semibold text-[11px] text-amber-100">
            ${checagem.ocorrencias.map(o => `<li>${escapeHtml(o.aulaNome)} (${escapeHtml(o.discNome)})</li>`).join("")}
          </ul>
          <div class="text-[10px] text-notion-muted pt-0.5">
            💡 Você pode manter o link se ambas as aulas compartilharem o mesmo caderno temático, ou editar para vincular um link exclusivo.
          </div>
        </div>
      `;
      if (notebookInput) {
        notebookInput.classList.remove("border-notion-border", "focus:border-indigo-500", "border-emerald-500/60");
        notebookInput.classList.add("border-amber-500", "focus:border-amber-500");
      }
    } else if (nbVal.includes("notebooklm.google.com") || /^https?:\/\//i.test(nbVal)) {
      notebookAviso.classList.remove("hidden");
      notebookAviso.innerHTML = `
        <div class="text-[11px] text-emerald-400 font-mono flex items-center gap-1.5 p-1">
          <span>✅ Link exclusivo verificado (sem duplicidade em outras aulas).</span>
        </div>
      `;
      if (notebookInput) {
        notebookInput.classList.remove("border-notion-border", "border-amber-500", "focus:border-amber-500");
        notebookInput.classList.add("border-emerald-500/60");
      }
    } else {
      notebookAviso.classList.add("hidden");
      notebookAviso.innerHTML = "";
      if (notebookInput) {
        notebookInput.classList.remove("border-amber-500", "border-emerald-500/60", "focus:border-amber-500");
        notebookInput.classList.add("border-notion-border", "focus:border-indigo-500");
      }
    }
  }
}

/**
 * Abre o modal de controle de data, presença e revisão para uma aula específica.
 * @param {string} discId
 * @param {string} aulaId
 */
export function abrirModalDataAula(discId, aulaId) {
  if (typeof document === "undefined") return;

  const ref = buscarRefDisciplina(discId);
  if (!ref) return;
  const { disc } = ref;
  const aula = (disc.aulas || []).find(a => a.id === aulaId);
  if (!aula) return;

  store.setState({
    disciplinaModalDataAula: disc,
    aulaModalDataAula: aula
  });

  const nomeEl = document.getElementById("modal-aula-nome");
  const subEl = document.getElementById("modal-aula-subtitulo");
  const dataInput = document.getElementById("form-aula-data");
  const presencaCheck = document.getElementById("form-aula-presenca");
  const revisaoCheck = document.getElementById("form-aula-revisao");
  const linkDriveInput = document.getElementById("form-aula-link-drive");
  const linkNbInput = document.getElementById("form-aula-link-notebook");

  if (nomeEl) nomeEl.textContent = aula.nome;
  if (subEl) subEl.textContent = `Matéria: ${disc.nome}`;
  if (dataInput) dataInput.value = aula.data_aula || "";
  if (presencaCheck) presencaCheck.checked = Boolean(aula.presenca);
  if (revisaoCheck) revisaoCheck.checked = Boolean(aula.revisao);

  if (linkDriveInput) {
    const driveUrl = aula.linkDrive || (aula.driveId && aula.driveId.length > 20 ? `https://drive.google.com/drive/folders/${aula.driveId}` : "");
    linkDriveInput.value = driveUrl;
  }
  if (linkNbInput) {
    linkNbInput.value = aula.linkNotebookLLM || "";
  }

  atualizarPreviewStatusModalAula();
  atualizarPreviewLinksAula();

  const modal = document.getElementById("modal-data-aula");
  if (modal) {
    modal.classList.remove("hidden");
    modal.classList.add("flex");
  }
}

/**
 * Fecha o modal de data da aula.
 */
export function fecharModalDataAula() {
  if (typeof document === "undefined") return;
  const modal = document.getElementById("modal-data-aula");
  if (modal) {
    modal.classList.add("hidden");
    modal.classList.remove("flex");
  }
}

/**
 * Salva as alterações de data, presença e revisão e despacha para a fila do Notion.
 */
export async function salvarModalDataAula() {
  if (typeof document === "undefined") return;

  const state = store.getState();
  const disc = state.disciplinaModalDataAula;
  const aula = state.aulaModalDataAula;
  if (!disc || !aula) return;

  const novaData = document.getElementById("form-aula-data")?.value || "";
  const novoPresenca = Boolean(document.getElementById("form-aula-presenca")?.checked);
  const novoRevisao = Boolean(document.getElementById("form-aula-revisao")?.checked);
  const novoLinkDrive = document.getElementById("form-aula-link-drive")?.value.trim() || "";
  const novoLinkNotebook = document.getElementById("form-aula-link-notebook")?.value.trim() || "";

  const btn = document.getElementById("btn-salvar-modal-aula");
  const txtOriginal = btn ? btn.innerHTML : "";
  if (btn) {
    btn.disabled = true;
    btn.innerHTML = `<span class="animate-spin text-sm">⏳</span> <span>Salvando...</span>`;
  }

  // Atualização Otimista
  aula.data_aula = novaData;
  aula.presenca = novoPresenca;
  aula.revisao = novoRevisao;
  aula.linkDrive = novoLinkDrive;
  aula.linkNotebookLLM = novoLinkNotebook;
  if (novoLinkDrive) {
    const driveIdExtraido = extrairDriveIdDeLink(novoLinkDrive);
    if (driveIdExtraido) aula.driveId = driveIdExtraido;
  }
  store.notify();

  try {
    const numAula = extrairNumeroAula(aula.nome);
    const res = await enviarFilaEdicaoAulaData({
      nomeMateria: disc.nomeOriginal || disc.nome,
      numAula,
      novaData,
      presenca: novoPresenca,
      revisao: novoRevisao,
      linkNotebookLLM: novoLinkNotebook,
      linkDrive: novoLinkDrive
    });

    if (res && res.ok === false) {
      mostrarToast("Salvo localmente na sessão", res.erro || "Aguardando sincronização com a nuvem.", "info");
    } else {
      mostrarToast("Aula & Links Salvos! 🤖", "Data, Presença, Google Drive e NotebookLM atualizados com sucesso.", "success");
    }
    fecharModalDataAula();

    const modalDet = document.getElementById("modal-aula-detalhes");
    if (modalDet && !modalDet.classList.contains("hidden")) {
      abrirModalVisualizacaoAula(disc.id, aula.id);
    }

    if (window.StudyOS && typeof window.StudyOS.recarregarVisaoAtual === "function") {
      window.StudyOS.recarregarVisaoAtual();
    }
  } catch (err) {
    mostrarToast("Salvo na sessão local", err.message, "info");
    fecharModalDataAula();
    if (window.StudyOS && typeof window.StudyOS.recarregarVisaoAtual === "function") {
      window.StudyOS.recarregarVisaoAtual();
    }
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = txtOriginal;
    }
  }
}

/**
 * Abre a visualização rápida e completa dos conteúdos de uma aula no modal #modal-aula-detalhes.
 * @param {string} discId
 * @param {string} aulaId
 */
export function abrirModalVisualizacaoAula(discId, aulaId) {
  if (typeof document === "undefined") return;

  const disc = buscarDisciplinaPorId(discId);
  if (!disc) return;
  const aula = (disc.aulas || []).find(a => a.id === aulaId);
  if (!aula) return;

  store.setState({
    disciplinaModalDataAula: disc,
    aulaModalDataAula: aula
  });

  const modal = document.getElementById("modal-aula-detalhes");
  const discBadge = document.getElementById("modal-aula-detalhes-disc-badge");
  const nomeBadge = document.getElementById("modal-aula-detalhes-nome-badge");
  const dataBadge = document.getElementById("modal-aula-detalhes-data-badge");
  const presencaBadge = document.getElementById("modal-aula-detalhes-presenca-badge");
  const revisaoBadge = document.getElementById("modal-aula-detalhes-revisao-badge");
  const tituloEl = document.getElementById("modal-aula-detalhes-titulo");
  const corpoEl = document.getElementById("modal-aula-detalhes-corpo");
  const btnEditDate = document.getElementById("modal-aula-detalhes-btn-edit-date");

  if (discBadge) discBadge.textContent = `${disc.icone || '📘'} ${disc.nome}`;
  if (nomeBadge) nomeBadge.textContent = aula.nome;

  const stAula = calcularStatusAula(aula);
  if (dataBadge) {
    dataBadge.textContent = aula.data_aula ? `📅 ${aula.data_aula}` : "📅 Sem data";
    dataBadge.className = aula.data_aula ? "font-mono text-[11px] text-cyan-300" : "font-mono text-[11px] text-notion-muted";
  }

  if (presencaBadge) {
    if (stAula.presenca) {
      presencaBadge.textContent = "✅ Presente";
      presencaBadge.className = "px-2 py-0.5 rounded font-mono text-[10px] bg-emerald-500/20 text-emerald-300 border border-emerald-500/40 inline-flex items-center gap-1";
    } else if (stAula.falta) {
      presencaBadge.textContent = "🟥 Falta";
      presencaBadge.className = "px-2 py-0.5 rounded font-mono text-[10px] bg-rose-500/20 text-rose-300 border border-rose-500/40 font-bold inline-flex items-center gap-1";
    } else {
      presencaBadge.textContent = "";
      presencaBadge.className = "hidden";
    }
  }

  if (revisaoBadge) {
    if (stAula.revisao) {
      revisaoBadge.textContent = "🆗 Revisada";
      revisaoBadge.className = "px-2 py-0.5 rounded font-mono text-[10px] bg-purple-500/20 text-purple-300 border border-purple-500/40 inline-flex items-center gap-1";
    } else {
      revisaoBadge.className = "hidden";
    }
  }

  if (tituloEl) tituloEl.textContent = obterTituloAula(aula, store.getState().cacheMarkdownTexto);
  if (btnEditDate) {
    if (isAdminAutenticado()) {
      btnEditDate.classList.remove("hidden");
      btnEditDate.onclick = (e) => {
        e.stopPropagation();
        abrirModalDataAula(disc.id, aula.id);
      };
    } else {
      btnEditDate.classList.add("hidden");
    }
  }

  if (corpoEl) {
    corpoEl.innerHTML = montarConteudoInternoDaAula(disc, aula);
    observarMidiasLazy(corpoEl);
    hidratarArtefatosAula(corpoEl, aula);
  }

  if (modal) {
    modal.classList.remove("hidden");
    modal.classList.add("flex");
  }
}

/**
 * Fecha a visualização rápida da aula e revoga Blobs para liberar memória RAM.
 */
export function fecharModalVisualizacaoAula() {
  if (typeof document === "undefined") return;
  const modal = document.getElementById("modal-aula-detalhes");
  if (modal) {
    modal.classList.add("hidden");
    modal.classList.remove("flex");
  }
  const aula = store.getState().aulaModalDataAula;
  if (aula) {
    desmontarArtefatosAula(aula.id);
    revogarBlobsDaAula(aula.id);
  }
}
