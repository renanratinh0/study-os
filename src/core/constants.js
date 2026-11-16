/**
 * Study OS V2 - Core Constants & Configuration
 * Centraliza presets de mídia, rotas remotas do Firebase,
 * estruturas padrão de dados e chaves de armazenamento local.
 */

export const EMPTY_DB_JSON = {
  usuario: "Renan",
  curso: "Ciência da Computação",
  diretorioRaiz: "G:\\Meu Drive\\CienciaComputacao",
  semestres: []
};

/**
 * 🔗 URL do Firebase Realtime Database para a fila de sincronização
 * de edições de Markdown, atividades, metadados e controle de aulas.
 */
export const FIREBASE_RTDB_URL = "https://study-os-fcc4a-default-rtdb.firebaseio.com";

/**
 * Lista de mídias suportadas e configuradas para exibição sob demanda nas aulas.
 */
export const OPCOES_MIDIA_AULA = [
  { id: "md", ordem: "1", icone: "📝", label: "1. MD", corAtiva: "bg-amber-500/20 text-amber-200 border-amber-400/60 shadow-xs" },
  { id: "img", ordem: "2", icone: "🖼️", label: "2. Imagens", corAtiva: "bg-emerald-500/20 text-emerald-200 border-emerald-400/60 shadow-xs" },
  { id: "pdf", ordem: "3", icone: "📄", label: "3. PDF Sem OCR", corAtiva: "bg-rose-500/20 text-rose-200 border-rose-400/60 shadow-xs" },
  { id: "video", ordem: "4", icone: "🎬", label: "4. Vídeo", corAtiva: "bg-purple-500/20 text-purple-200 border-purple-400/60 shadow-xs" },
  { id: "audio", ordem: "5", icone: "🎧", label: "5. M4A", corAtiva: "bg-pink-500/20 text-pink-200 border-pink-400/60 shadow-xs" },
  { id: "notebook", ordem: "6", icone: "🤖", label: "6. NotebookLM", corAtiva: "bg-indigo-500/25 text-indigo-200 border-indigo-400/60 shadow-xs" }
];

/**
 * Mapeamento de presets rápidos de filtros de mídias para a barra de seleção da matéria.
 */
export const PRESETS_MIDIA = {
  "todas": ["md", "img", "pdf", "video", "audio", "notebook"],
  "img+pdf": ["img", "pdf"],
  "md+img": ["md", "img"],
  "img+audio": ["img", "audio"],
  "video+audio": ["video", "audio"],
  "so_img": ["img"],
  "so_pdf": ["pdf"],
  "so_md": ["md"]
};

/**
 * Tema visual padrão do sistema (Sempre Escuro por padrão).
 */
export const DEFAULT_THEME = "dark";

/**
 * Chaves para persistência segura no LocalStorage.
 */
export const STORAGE_KEYS = {
  DB_CACHE: "studyos_db_v3",
  MD_EDITS_CACHE: "studyos_md_edits_cache",
  BASE_MEDIA_PATH: "studyos_base_media_path",
  THEME: "studyos_theme"
};

/**
 * Prefixo padrão de caminho relativo para busca de mídias locais em disco.
 */
export const DEFAULT_MEDIA_PATH = "../CienciaComputacao";
