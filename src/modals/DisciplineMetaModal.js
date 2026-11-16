/**
 * Study OS V2 - DisciplineMetaModal (Lazy Loaded via Dynamic Import)
 * Modal de edição de metadados da matéria (ícone, nome, professor, status, tags, imagem de capa)
 * com atualização otimista e sincronização assíncrona na fila do Notion via Firebase RTDB.
 */

import { store, buscarRefDisciplina } from "../core/store.js";
import { mostrarToast } from "../utils/domHelpers.js";
import { enviarFilaEdicaoMateria } from "../services/api.js";

/**
 * Abre o modal preenchendo os dados da matéria indicada.
 * @param {string} discId
 */
export function abrirModalEditarDisciplina(discId) {
  if (typeof document === "undefined") return;

  const ref = buscarRefDisciplina(discId);
  if (!ref) return;
  const { disc } = ref;

  store.setState({ disciplinaModalEditar: disc });

  const iconInput = document.getElementById("form-disc-icone");
  const nameInput = document.getElementById("form-disc-nome");
  const profInput = document.getElementById("form-disc-prof");
  const statusSelect = document.getElementById("form-disc-status");
  const tagsInput = document.getElementById("form-disc-tags");
  const coverInput = document.getElementById("form-disc-cover");
  const coverPreview = document.getElementById("form-disc-cover-preview");

  if (iconInput) iconInput.value = disc.icone || "📘";
  if (nameInput) nameInput.value = disc.nome || "";
  if (profInput) profInput.value = disc.prof || "";
  if (statusSelect) statusSelect.value = disc.status || "Em andamento";
  if (tagsInput) tagsInput.value = (disc.TAGS || []).join(", ");
  if (coverInput) coverInput.value = disc.cover || "";
  if (coverPreview) {
    coverPreview.src = disc.cover || "https://images.unsplash.com/photo-1518770660439-4636190af475?auto=format&fit=crop&w=1000&q=80";
  }

  const modal = document.getElementById("modal-editar-disciplina");
  if (modal) {
    modal.classList.remove("hidden");
    modal.classList.add("flex");
  }
}

/**
 * Fecha o modal de metadados da matéria.
 */
export function fecharModalEditarDisciplina() {
  if (typeof document === "undefined") return;
  const modal = document.getElementById("modal-editar-disciplina");
  if (modal) {
    modal.classList.add("hidden");
    modal.classList.remove("flex");
  }
  store.setState({ disciplinaModalEditar: null });
}

/**
 * Salva as alterações da matéria de forma otimista e despacha para a fila do Notion.
 */
export async function salvarModalEditarDisciplina() {
  if (typeof document === "undefined") return;

  const state = store.getState();
  const disc = state.disciplinaModalEditar;
  if (!disc) return;

  const novoNome = document.getElementById("form-disc-nome")?.value.trim() || disc.nome;
  const novoIcone = document.getElementById("form-disc-icone")?.value.trim() || disc.icone || "📘";
  const novoProf = document.getElementById("form-disc-prof")?.value.trim() || disc.prof;
  const novoStatus = document.getElementById("form-disc-status")?.value || disc.status;
  const tagsRaw = document.getElementById("form-disc-tags")?.value.trim() || "";
  const novasTags = tagsRaw ? tagsRaw.split(",").map(t => t.trim()).filter(Boolean) : (disc.TAGS || []);
  const novoCover = document.getElementById("form-disc-cover")?.value.trim() || disc.cover;

  const btn = document.getElementById("btn-salvar-modal-disc");
  const txtOriginal = btn ? btn.innerHTML : "";
  if (btn) {
    btn.disabled = true;
    btn.innerHTML = `<span class="animate-spin text-sm">⏳</span> <span>Salvando no Notion...</span>`;
  }

  const nomeAntigo = disc.nomeOriginal || disc.nome;

  // Atualização Otimista no Store
  disc.nome = novoNome;
  disc.icone = novoIcone;
  disc.prof = novoProf;
  disc.status = novoStatus;
  disc.TAGS = novasTags;
  disc.cover = novoCover;
  store.notify();

  try {
    const res = await enviarFilaEdicaoMateria({
      nomeAntigo,
      novoNome,
      novoIcone,
      novoProf,
      novoStatus,
      novasTags,
      novoCover
    });

    if (res && res.ok === false) {
      throw new Error(res.erro || "Falha ao enviar para o Firebase");
    }

    mostrarToast("Matéria Atualizada! 🎓", `Metadados de "${novoNome}" salvos no Notion.`, "success");
    fecharModalEditarDisciplina();

    // Notifica o app para re-renderizar a tela atual
    if (window.StudyOS && typeof window.StudyOS.recarregarVisaoAtual === "function") {
      window.StudyOS.recarregarVisaoAtual();
    }
  } catch (err) {
    mostrarToast("Erro ao salvar matéria", err.message, "error");
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = txtOriginal;
    }
  }
}
