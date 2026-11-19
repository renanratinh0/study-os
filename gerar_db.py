import os
import re
import ast
import sys
import json
import zlib
import time
import pickle
import sqlite3
import shutil
import tempfile
import warnings
import logging
import webbrowser
import unicodedata
import urllib.request
import urllib.parse
import urllib.error
from http.server import HTTPServer, BaseHTTPRequestHandler
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

# ==============================================================================
# 🔇 SILENCIADOR DE AVISOS DE FONTES DO PYPDF / PYPDF2
# ==============================================================================
warnings.filterwarnings("ignore")
logging.getLogger("pypdf").setLevel(logging.CRITICAL)
logging.getLogger("PyPDF2").setLevel(logging.CRITICAL)

# ==============================================================================
# ⚙️ CONFIGURAÇÕES GERAIS E CREDENCIAIS GOOGLE DRIVE
# ==============================================================================
CAMINHOS_DRIVE_POSSIVEIS = [

    Path(r"G:\Meu Drive\CienciaComputacao"),
    Path("."),
]

PASTA_RAIZ_ID_PADRAO = "1_E2qxLk4inkCoT2dccBjJ1GL2HVTDU2N"

BACKUP_NOTEBOOKLM_PATH = Path("notebooklm_colecoes_BACKUP_2026-08-19.json")
DB_ATUAL_PATH = Path("db.personal.json")
DB_FALLBACK_PATH = Path("db_backup.json")
DB_SAIDA_PATH = Path("db.personal.json")

FIREBASE_URL = "https://study-os-beta-default-rtdb.firebaseio.com"
NOTION_CONFIG_PATH = Path("notion_config.json")
STUDIO_ADMIN_GATE = "studyos_admin_v1"

CREDENTIALS_PATH = Path("credentials.json")
TOKEN_JSON_PATH = Path("token.json")
TOKEN_PICKLE_PATH = Path("token.pickle")

# Muda para True se quiser forçar a verificação de permissão pública em cada pasta
TORNAR_PASTAS_PUBLICAS_AUTOMATICAMENTE = True

# Credenciais OAuth do Google Drive (Carregadas via credentials.json ou variáveis de ambiente)
CREDENCIAIS_EMBUTIDAS = {
    "installed": {
        "client_id": os.environ.get("GOOGLE_OAUTH_CLIENT_ID", "SEU_CLIENT_ID.apps.googleusercontent.com"),
        "project_id": os.environ.get("GOOGLE_PROJECT_ID", "seu-projeto-gcp"),
        "auth_uri": "https://accounts.google.com/o/oauth2/auth",
        "token_uri": "https://oauth2.googleapis.com/token",
        "auth_provider_x509_cert_url": "https://www.googleapis.com/oauth2/v1/certs",
        "client_secret": os.environ.get("GOOGLE_OAUTH_CLIENT_SECRET", "SEU_CLIENT_SECRET"),
        "redirect_uris": ["http://localhost"]
    }
}

SCOPES = ["https://www.googleapis.com/auth/drive"]

# Detecta motor de leitura de PDF instalado
BIBLIOTECA_PDF = "nativo"
try:
    import fitz  # PyMuPDF
    BIBLIOTECA_PDF = "pymupdf"
except ImportError:
    try:
        import pypdf as _pypdf_mod
        BIBLIOTECA_PDF = "pypdf"
    except ImportError:
        try:
            import PyPDF2 as _pypdf_mod
            BIBLIOTECA_PDF = "pypdf2"
        except ImportError:
            BIBLIOTECA_PDF = "nativo"


# ==============================================================================
# 🛠️ FUNÇÕES AUXILIARES DE TEXTO E ARQUIVOS
# ==============================================================================
def normalizar_texto(texto: str) -> str:
    """Remove emojis, acentos e símbolos, preservando '+' para diferenciar C de C++."""
    if not texto:
        return ""
    sem_acento = "".join(
        c for c in unicodedata.normalize("NFD", str(texto))
        if unicodedata.category(c) != "Mn"
    )
    limpo = re.sub(r"[^a-zA-Z0-9+]+", " ", sem_acento).strip().lower()
    return re.sub(r"\s+", " ", limpo)


def normalizar_nome_arquivo(nome: str) -> str:
    """Normaliza nome de arquivo ou pasta mantendo pontuação básica para casamento exato."""
    if not nome:
        return ""
    return unicodedata.normalize("NFC", str(nome)).strip().lower()


def eh_pasta_semestre_ou_cursos(nome_pasta: str) -> bool:
    """Aceita SOMENTE pastas de Semestre (1º ao 8º) e a pasta Cursos."""
    norm = normalizar_texto(nome_pasta)
    if re.match(r"^[1-8]\s*semestre$", norm) or "semestre" in norm:
        return True
    if norm in ("cursos", "curso"):
        return True
    return False


def chave_ordenacao_pasta_raiz(item: dict) -> tuple:
    nome = item.get("nome", "")
    norm = normalizar_texto(nome)
    if norm in ("cursos", "curso"):
        return (1, 99, nome)
    match_num = re.search(r"(\d+)", norm)
    if match_num:
        return (0, int(match_num.group(1)), nome)
    return (2, 999, nome)


def chave_ordenacao_aulas(item: dict) -> tuple:
    nome = item.get("nome", "")
    norm = normalizar_texto(nome)
    if "conclusao" in norm:
        return (1, 999, nome)
    match_num = re.search(r"(\d+)", nome)
    if match_num:
        return (0, int(match_num.group(1)), nome)
    return (2, 998, nome)


def carregar_json_seguro(caminho: Path):
    if not caminho or not caminho.exists():
        return None
    texto = caminho.read_text(encoding="utf-8-sig", errors="replace").strip()
    try:
        return json.loads(texto)
    except json.JSONDecodeError:
        decoder = json.JSONDecoder()
        obj, _ = decoder.raw_decode(texto)
        return obj


def ler_conteudo_markdown(caminho: Path) -> str:
    for encoding in ("utf-8-sig", "utf-8", "cp1252", "latin-1"):
        try:
            return caminho.read_text(encoding=encoding)
        except Exception:
            continue
    return ""


def normalizar_nome_classificacao(nome: str) -> str:
    """Remove acentos e normaliza para lowercase para classificação estrita por nome."""
    sem_acento = "".join(
        c for c in unicodedata.normalize("NFD", str(nome or ""))
        if unicodedata.category(c) != "Mn"
    )
    return Path(sem_acento.strip()).name.lower()


def classificar_artefato_arquivo(nome_arquivo: str) -> str:
    """
    Classifica arquivos da aula com prioridade estrita por nome (case-insensitive):
      - *mapa-mental.json -> 'mindmap'
      - *flashcards.md    -> 'flashcards'
      - *quiz.md          -> 'quiz'
      - *relatorio.md     -> 'relatorio'
      - qualquer outro .md/.markdown -> 'md_principal'
      - demais arquivos   -> 'outro'
    """
    nome_norm = normalizar_nome_classificacao(nome_arquivo)
    if nome_norm.endswith("mapa-mental.json"):
        return "mindmap"
    if nome_norm.endswith("flashcards.md"):
        return "flashcards"
    if nome_norm.endswith("quiz.md"):
        return "quiz"
    if nome_norm.endswith("relatorio.md"):
        return "relatorio"
    if Path(nome_norm).suffix in (".md", ".markdown"):
        return "md_principal"
    return "outro"


def ler_conteudo_json(caminho: Path):
    """Lê e faz o parsing seguro de um arquivo JSON da aula."""
    texto = ler_conteudo_markdown(caminho)
    if not texto.strip():
        return None
    try:
        return json.loads(texto)
    except Exception:
        return None


def limpar_flashcards_markdown_notebooklm(texto: str) -> str:
    """Converte wrappers `{'flashcardContentBlock': [...]}` em Markdown limpo."""
    if not texto or "flashcardContentBlock" not in texto:
        return texto

    linhas_out = []
    for linha in str(texto).splitlines():
        if "flashcardContentBlock" in linha and "{" in linha:
            idx = linha.find("{")
            prefixo = linha[:idx]
            bruto = linha[idx:].strip()
            obj = None
            try:
                obj = ast.literal_eval(bruto)
            except Exception:
                try:
                    obj = json.loads(bruto)
                except Exception:
                    obj = None

            if isinstance(obj, dict) and isinstance(obj.get("flashcardContentBlock"), list):
                partes = []
                for b in obj["flashcardContentBlock"]:
                    if not isinstance(b, dict):
                        continue
                    if b.get("type") == "text" and b.get("content"):
                        partes.append(str(b["content"]).strip())
                    elif b.get("type") == "image" and b.get("alt"):
                        partes.append(f"[Imagem: {str(b['alt']).strip()}]")
                    elif b.get("content"):
                        partes.append(str(b["content"]).strip())
                combinado = "\n".join(p for p in partes if p).strip()
                if combinado:
                    linhas_out.append(f"{prefixo}{combinado}")
                    continue

        linhas_out.append(linha)

    sufixo = "\n" if str(texto).endswith("\n") else ""
    return "\n".join(linhas_out) + sufixo


def obter_firebase_secret() -> str:
    secret = os.environ.get("FIREBASE_SECRET", "").strip()
    if secret:
        return secret
    if NOTION_CONFIG_PATH.exists():
        try:
            cfg = carregar_json_seguro(NOTION_CONFIG_PATH) or {}
            return str(cfg.get("firebase_secret") or "").strip()
        except Exception:
            pass
    return ""


def firebase_url_auth(caminho: str) -> str:
    base = f"{FIREBASE_URL.rstrip('/')}/{caminho.lstrip('/')}"
    secret = obter_firebase_secret()
    if secret:
        sep = "&" if "?" in base else "?"
        return f"{base}{sep}auth={urllib.parse.quote(secret)}"
    return base


def carregar_db_firebase() -> dict:
    """Busca o `/db_json` atual do Firebase RTDB para preservar atividades e datas do Notion."""
    url = firebase_url_auth("db_json.json")
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "StudyOS-GeradorDB/3.2"}, method="GET")
        with urllib.request.urlopen(req, timeout=25) as resp:
            raw = resp.read().decode("utf-8", errors="replace")
            dados = json.loads(raw) if raw else None
            if isinstance(dados, dict) and dados.get("filhos"):
                print("☁️ Firebase (/db_json) carregado para preservar atividades, capas e datas das aulas.")
                return dados
    except Exception as e:
        print(f"⚠️ Aviso ao ler Firebase (/db_json): {e}")
    return {}


def slugify_py(texto: str) -> str:
    """Normaliza string em slug idêntico ao `slugify` do frontend."""
    s = "".join(
        c for c in unicodedata.normalize("NFD", str(texto or ""))
        if unicodedata.category(c) != "Mn"
    )
    return re.sub(r"[^a-z0-9]+", "-", s.lower()).strip("-") or "item"


def extrair_titulo_h1_markdown(texto: str) -> str:
    """Extrai e limpa o título principal H1 de um arquivo Markdown (máx. 200 caracteres)."""
    if not texto:
        return ""
    sem_yaml = re.sub(r"^\ufeff?\s*---\r?\n[\s\S]*?\r?\n---\s*(?:\r?\n|$)", "", str(texto)).strip()
    linhas = [ln.strip() for ln in sem_yaml.splitlines() if ln.strip()]
    linha_h1 = next((ln for ln in linhas if re.match(r"^(?:\\?#)+", ln)), linhas[0] if linhas else "")
    if not linha_h1:
        return ""
    limpo = re.sub(r"^(?:\\?#)+\s*", "", linha_h1).strip()
    limpo = re.sub(
        r"^(?:aula\s*\d+|aula\s*(?:de\s+)?conclus[aã]o|aula\s*(?:de\s+)?introdu[cç][aã]o|aula)\s*[-:–—|]\s*",
        "",
        limpo,
        flags=re.IGNORECASE,
    ).strip()
    return limpo[:200] if len(limpo) <= 240 else ""


def _eh_novo_artefato_dict(item: dict) -> bool:
    role = str(item.get("artifactRole") or "").strip().lower()
    nome_low = str(item.get("nome") or "").strip().lower()
    return role in ("mindmap", "flashcards", "quiz", "relatorio") or nome_low.endswith(
        ("mapa-mental.json", "flashcards.md", "quiz.md", "relatorio.md")
    )


def _copiar_no_leve(valor):
    if isinstance(valor, list):
        return [_copiar_no_leve(v) for v in valor]
    if not isinstance(valor, dict):
        return valor
    out = {}
    h1_salvo = str(valor.get("tituloH1") or "").strip()
    if not h1_salvo and isinstance(valor.get("conteudoTexto"), str) and not _eh_novo_artefato_dict(valor):
        h1_salvo = extrair_titulo_h1_markdown(valor["conteudoTexto"])
    for k, v in valor.items():
        if k in ("conteudoTexto", "conteudoJson"):
            continue
        out[k] = _copiar_no_leve(v)
    if h1_salvo:
        out["tituloH1"] = h1_salvo
    return out


def gerar_catalogo_leve_db(db_final: dict) -> dict:
    """Remove textos/JSONs pesados mantendo `tituloH1` e metadados dos arquivos/artefatos."""
    if not isinstance(db_final, dict):
        return {}
    leve = _copiar_no_leve(db_final)
    leve["admin_gate"] = STUDIO_ADMIN_GATE
    if not leve.get("atualizado_em"):
        leve["atualizado_em"] = int(time.time() * 1000)
    return leve


def atribuir_chaves_conteudo_db(db_final: dict) -> list:
    """
    Calcula a chave única de `/db_conteudo/{chave}` para cada aula (usando o slug compatível
    com `aula.id`, e desambiguando com `conteudoId` quando disciplinas distintas colidem no slug,
    como `C` e `C++`). Retorna lista de `(chave_aula, aula_node)`.
    """
    entradas = []
    contagem_slugs = {}
    for sem in db_final.get("filhos", []):
        sem_nome = sem.get("nome", "")
        for mat in sem.get("filhos", []):
            mat_nome = mat.get("nome", "")
            mat_limpo = re.sub(r"^[^\w\s]+\s*", "", mat_nome).strip() or mat_nome
            for aula in mat.get("filhos", []):
                if not isinstance(aula, dict) or (aula.get("tipo") != "pasta" and not isinstance(aula.get("filhos"), list)):
                    continue
                aula_slug = slugify_py(f"{sem_nome}-{mat_limpo}-{aula.get('nome', '')}")
                contagem_slugs[aula_slug] = contagem_slugs.get(aula_slug, 0) + 1
                entradas.append((aula_slug, aula))

    pares = []
    for aula_slug, aula in entradas:
        if contagem_slugs.get(aula_slug, 0) > 1 and aula.get("id"):
            chave = str(aula["id"])
            aula["conteudoId"] = chave
        else:
            chave = str(aula.get("conteudoId") or aula_slug)
        pares.append((chave, aula))
    return pares


def _sanitizar_chave_firebase(chave: str) -> str:
    """Substitui caracteres proibidos em chaves do Firebase RTDB: . $ # [ ] /"""
    substituicoes = {".": "_p_", "$": "_ds_", "#": "_h_", "[": "_bo_", "]": "_bc_", "/": "_sl_"}
    for k, v in substituicoes.items():
        chave = chave.replace(k, v)
    return chave


def extrair_conteudo_aula_para_firebase(aula_node: dict) -> dict:
    """Extrai MDs e artefatos inline de uma aula para `/db_conteudo/{chave}`."""
    mds = {}
    artifacts = {}
    for item in aula_node.get("filhos", []):
        if not isinstance(item, dict) or item.get("tipo") == "pasta":
            continue
        nome = str(item.get("nome") or "").strip()
        role = classificar_artefato_arquivo(nome)
        if role in ("mindmap", "flashcards", "quiz", "relatorio"):
            entry = {"nome": nome}
            if role == "mindmap" and item.get("conteudoJson") is not None:
                entry["conteudoJson"] = item["conteudoJson"]
            if item.get("conteudoTexto"):
                entry["conteudoTexto"] = item["conteudoTexto"]
            if "conteudoJson" in entry or "conteudoTexto" in entry:
                artifacts[role] = entry
        elif (role == "md_principal" or nome.lower().endswith((".md", ".markdown"))) and item.get("conteudoTexto"):
            if nome:
                mds[_sanitizar_chave_firebase(nome)] = item["conteudoTexto"]

    raw_arts = aula_node.get("artifacts")
    if isinstance(raw_arts, dict):
        for role in ("mindmap", "flashcards", "quiz", "relatorio"):
            val = raw_arts.get(role)
            if isinstance(val, dict):
                entry = {"nome": str(val.get("nome") or role)}
                if role == "mindmap" and val.get("conteudoJson") is not None:
                    entry["conteudoJson"] = val["conteudoJson"]
                if val.get("conteudoTexto"):
                    entry["conteudoTexto"] = val["conteudoTexto"]
                if "conteudoJson" in entry or "conteudoTexto" in entry:
                    artifacts[role] = entry

    return {
        "admin_gate": STUDIO_ADMIN_GATE,
        "atualizado_em": int(time.time() * 1000),
        "mds": mds,
        "artifacts": artifacts,
    }


def _firebase_put_json(caminho: str, payload: dict, timeout: int = 45) -> bool:
    url = firebase_url_auth(f"{caminho.strip('/')}.json")
    body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=body,
        headers={"Content-Type": "application/json", "User-Agent": "StudyOS-GeradorDB/3.2"},
        method="PUT",
    )
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return resp.status in (200, 204)


def enviar_db_para_firebase(db_final: dict) -> bool:
    """
    Envia o Catálogo Leve (sem textos/JSONs inline) para `/db_json`, grava versão em
    `/db_meta` e envia os conteúdos sob demanda apenas das aulas com arquivos em `/db_conteudo/{chave}`.
    """
    if not isinstance(db_final, dict):
        return False
    agora_ms = int(db_final.get("atualizado_em") or int(time.time() * 1000))
    db_final["admin_gate"] = STUDIO_ADMIN_GATE
    db_final["atualizado_em"] = agora_ms

    pares_aulas = atribuir_chaves_conteudo_db(db_final)
    catalogo_leve = gerar_catalogo_leve_db(db_final)
    body_leve = json.dumps(catalogo_leve, ensure_ascii=False).encode("utf-8")
    body_bruto = json.dumps(db_final, ensure_ascii=False).encode("utf-8")
    print(
        f"☁️ Enviando catálogo leve ({len(body_leve) / (1024 * 1024):.2f} MB vs "
        f"{len(body_bruto) / (1024 * 1024):.2f} MB bruto) para Firebase (/db_json)..."
    )
    try:
        url = firebase_url_auth("db_json.json")
        req = urllib.request.Request(
            url,
            data=body_leve,
            headers={"Content-Type": "application/json", "User-Agent": "StudyOS-GeradorDB/3.2"},
            method="PUT",
        )
        with urllib.request.urlopen(req, timeout=90) as resp:
            ok = resp.status in (200, 204)
            if not ok:
                return False

        _firebase_put_json("db_meta", {
            "atualizado_em": agora_ms,
            "modo": "catalogo_leve",
            "admin_gate": STUDIO_ADMIN_GATE,
        }, timeout=25)

        pendencias = []
        for chave_aula, aula_node in pares_aulas:
            payload_aula = extrair_conteudo_aula_para_firebase(aula_node)
            if payload_aula["mds"] or payload_aula["artifacts"]:
                pendencias.append((chave_aula, payload_aula))

        enviados_ok = 0
        if pendencias:
            print(f"📚 Enviando conteúdo sob demanda de {len(pendencias)} aulas para Firebase (/db_conteudo)...")
            with ThreadPoolExecutor(max_workers=8) as pool:
                futs = {
                    pool.submit(_firebase_put_json, f"db_conteudo/{chave}", pl, 30): chave
                    for chave, pl in pendencias
                }
                for fut in as_completed(futs):
                    try:
                        if fut.result():
                            enviados_ok += 1
                    except Exception:
                        pass
            print(f"   ✅ Conteúdos sob demanda enviados: {enviados_ok}/{len(pendencias)} aulas!")

        print("   ✅ Firebase (/db_json + /db_meta + /db_conteudo) atualizado com sucesso!")
        return True
    except urllib.error.HTTPError as e:
        if e.code in (401, 403):
            print("   ⚠️ Firebase retornou HTTP 401/403 (Permissão negada ao escrever em /db_json).")
            print("   👉 Para ativar a gravação automática na nuvem, cole o conteúdo de `database.rules.json`")
            print("      na aba Regras do Console do Firebase Realtime Database (ou adicione `firebase_secret` em `notion_config.json`).")
        else:
            print(f"   ⚠️ Falha HTTP {e.code} ao atualizar Firebase (/db_json): {e.reason}")
    except Exception as e:
        print(f"   ⚠️ Falha ao enviar para o Firebase (/db_json): {e}")
    return False


def detectar_mime_type(caminho: Path) -> str:
    ext = caminho.suffix.lower()
    mapa = {
        ".md": "text/markdown",
        ".markdown": "text/markdown",
        ".json": "application/json",
        ".txt": "text/plain",
        ".c": "text/plain",
        ".cpp": "text/plain",
        ".py": "text/plain",
        ".java": "text/plain",
        ".kt": "text/plain",
        ".js": "text/plain",
        ".ts": "text/plain",
        ".html": "text/html",
        ".css": "text/css",
        ".pdf": "application/pdf",
        ".mp4": "video/mp4",
        ".mov": "video/quicktime",
        ".webm": "video/webm",
        ".m4a": "audio/mpeg",
        ".mp3": "audio/mpeg",
        ".aac": "audio/aac-adts",
        ".wav": "audio/wav",
        ".png": "image/png",
        ".jpg": "image/jpeg",
        ".jpeg": "image/jpeg",
        ".webp": "image/webp",
        ".gif": "image/gif",
    }
    return mapa.get(ext, "application/octet-stream")


# ==============================================================================
# 🔍 DETECTOR RÁPIDO DE OCR EM PDF (EARLY EXIT)
# ==============================================================================
def _inspecionar_pdf_nativo(caminho_pdf: Path) -> int:
    try:
        dados = caminho_pdf.read_bytes()
    except Exception:
        return 0

    if (b"/Font" not in dados) and (b"/ToUnicode" not in dados):
        return 0

    caracteres_encontrados = 0
    padrao_stream = re.compile(rb"stream[\r\n]+(.*?)[\r\n]+endstream", re.DOTALL)

    for idx, match in enumerate(padrao_stream.finditer(dados)):
        if idx >= 35:
            break
        bruto = match.group(1)
        try:
            texto_stream = zlib.decompress(bruto)
        except Exception:
            try:
                texto_stream = zlib.decompress(bruto.strip(b"\r\n"))
            except Exception:
                texto_stream = bruto

        for bloco_bt in re.findall(rb"BT(.*?)ET", texto_stream, re.DOTALL):
            literais = re.findall(rb"\(([^()\\]{2,})\)", bloco_bt)
            for lit in literais:
                letras = sum(1 for b in lit if (65 <= b <= 90) or (97 <= b <= 122) or (48 <= b <= 57))
                caracteres_encontrados += letras
            if caracteres_encontrados >= 50:
                return caracteres_encontrados

    return caracteres_encontrados


def verificar_pdf_ocr(caminho_pdf: Path, nodo_antigo: dict = None) -> dict:
    """
    Verifica se o PDF possui texto selecionável (OCR) com parada imediata (Early Exit)
    assim que encontra 50 caracteres úteis.
    """
    if not caminho_pdf or not caminho_pdf.exists():
        if nodo_antigo and "temOCR" in nodo_antigo:
            tem_ocr_cache = bool(nodo_antigo["temOCR"])
            return {
                "temOCR": tem_ocr_cache,
                "statusOCR": "com_ocr" if tem_ocr_cache else "sem_ocr",
                "caracteresOCR": int(nodo_antigo.get("caracteresOCR", 0)),
            }
        return {"temOCR": True, "statusOCR": "com_ocr", "caracteresOCR": 0}

    # Reaproveita cache se o PDF já foi verificado anteriormente
    if nodo_antigo and "temOCR" in nodo_antigo and "caracteresOCR" in nodo_antigo:
        tem_ocr_cache = bool(nodo_antigo["temOCR"])
        return {
            "temOCR": tem_ocr_cache,
            "statusOCR": "com_ocr" if tem_ocr_cache else "sem_ocr",
            "caracteresOCR": int(nodo_antigo.get("caracteresOCR", 0)),
        }

    caracteres_extraidos = 0
    try:
        if BIBLIOTECA_PDF == "pymupdf":
            with fitz.open(caminho_pdf) as doc:
                for i in range(min(len(doc), 5)):
                    limpo = re.sub(r"\s+", "", doc[i].get_text("text") or "")
                    caracteres_extraidos += len(limpo)
                    if caracteres_extraidos >= 50:
                        break

        elif BIBLIOTECA_PDF in ("pypdf", "pypdf2"):
            leitor = _pypdf_mod.PdfReader(str(caminho_pdf), strict=False)
            for i in range(min(len(leitor.pages), 5)):
                try:
                    limpo = re.sub(r"\s+", "", leitor.pages[i].extract_text() or "")
                except Exception:
                    limpo = ""
                caracteres_extraidos += len(limpo)
                if caracteres_extraidos >= 50:
                    break
        else:
            caracteres_extraidos = _inspecionar_pdf_nativo(caminho_pdf)
    except Exception:
        caracteres_extraidos = _inspecionar_pdf_nativo(caminho_pdf)

    tem_ocr = caracteres_extraidos >= 25
    return {
        "temOCR": tem_ocr,
        "statusOCR": "com_ocr" if tem_ocr else "sem_ocr",
        "caracteresOCR": caracteres_extraidos,
    }


# ==============================================================================
# 🔑 AUTENTICAÇÃO OAUTH2 GOOGLE DRIVE (GERA TOKEN.JSON AUTOMATICAMENTE)
# ==============================================================================
def obter_config_oauth() -> dict:
    if CREDENTIALS_PATH.exists():
        dados = carregar_json_seguro(CREDENTIALS_PATH)
        if dados:
            return dados.get("installed") or dados.get("web") or CREDENCIAIS_EMBUTIDAS["installed"]
    else:
        # Cria o credentials.json automaticamente para facilitar futuros usos
        try:
            CREDENTIALS_PATH.write_text(json.dumps(CREDENCIAIS_EMBUTIDAS, indent=2), encoding="utf-8")
        except Exception:
            pass
    return CREDENCIAIS_EMBUTIDAS["installed"]


def renovar_access_token_http(refresh_token: str, client_id: str, client_secret: str, token_uri: str) -> str:
    payload = urllib.parse.urlencode({
        "client_id": client_id,
        "client_secret": client_secret,
        "refresh_token": refresh_token,
        "grant_type": "refresh_token",
    }).encode("utf-8")
    req = urllib.request.Request(
        token_uri,
        data=payload,
        headers={"Content-Type": "application/x-www-form-urlencoded"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=15) as resp:
        dados = json.loads(resp.read().decode("utf-8"))
        return dados.get("access_token", "")


def iniciar_login_oauth_navegador_puro() -> str:
    """
    Abre o navegador para autorizar o Google Drive mesmo sem precisar
    de google-auth-oauthlib instalado, salvando o token.json automaticamente.
    """
    cfg = obter_config_oauth()
    client_id = cfg["client_id"]
    client_secret = cfg["client_secret"]
    auth_uri = cfg.get("auth_uri", "https://accounts.google.com/o/oauth2/auth")
    token_uri = cfg.get("token_uri", "https://oauth2.googleapis.com/token")

    # Tenta usar google_auth_oauthlib se estiver instalado
    try:
        from google_auth_oauthlib.flow import InstalledAppFlow
        print("🔐 Abrindo navegador para autorizar o Google Drive (InstalledAppFlow)...")
        flow = InstalledAppFlow.from_client_config({"installed": cfg}, SCOPES)
        creds = flow.run_local_server(port=0)
        TOKEN_JSON_PATH.write_text(creds.to_json(), encoding="utf-8")
        with open(TOKEN_PICKLE_PATH, "wb") as f_pk:
            pickle.dump(creds, f_pk)
        print("   ✅ Login concluído! 'token.json' salvo com sucesso.")
        return creds.token
    except ImportError:
        pass
    except Exception as e:
        print(f"   ⚠️ Aviso no InstalledAppFlow ({e}), tentando autenticador HTTP nativo...")

    # Fallback 100% Python Puro (sem precisar instalar bibliotecas extras)
    porta = 8765
    redirect_uri = f"http://localhost:{porta}"
    codigo_capturado = {"code": None}

    class OAuthHandler(BaseHTTPRequestHandler):
        def do_GET(self):
            parsed = urllib.parse.urlparse(self.path)
            qs = urllib.parse.parse_qs(parsed.query)
            if "code" in qs:
                codigo_capturado["code"] = qs["code"][0]
                self.send_response(200)
                self.send_header("Content-Type", "text/html; charset=utf-8")
                self.end_headers()
                self.wfile.write(
                    b"<html><body style='font-family:sans-serif;background:#111;color:#fff;text-align:center;padding:60px;'>"
                    b"<h2>&#9989; Google Drive Autorizado com Sucesso!</h2>"
                    b"<p>Voce ja pode fechar esta aba e voltar ao terminal do Study OS.</p></body></html>"
                )
            else:
                self.send_response(400)
                self.end_headers()

        def log_message(self, format, *args):
            return

    servidor = HTTPServer(("localhost", porta), OAuthHandler)
    servidor.timeout = 120

    params_auth = urllib.parse.urlencode({
        "client_id": client_id,
        "redirect_uri": redirect_uri,
        "response_type": "code",
        "scope": " ".join(SCOPES),
        "access_type": "offline",
        "prompt": "consent",
    })
    url_login = f"{auth_uri}?{params_auth}"
    print("\n" + "=" * 78)
    print("🔐 AUTORIZAÇÃO DO GOOGLE DRIVE NECESSÁRIA (1ª VEZ)")
    print("   Abrindo seu navegador para login... Caso não abra sozinho, acesse:")
    print(f"   {url_login}")
    print("=" * 78)
    webbrowser.open(url_login)

    servidor.handle_request()
    servidor.server_close()

    if not codigo_capturado["code"]:
        print("   ❌ Código OAuth não recebido.")
        return ""

    payload = urllib.parse.urlencode({
        "code": codigo_capturado["code"],
        "client_id": client_id,
        "client_secret": client_secret,
        "redirect_uri": redirect_uri,
        "grant_type": "authorization_code",
    }).encode("utf-8")

    req = urllib.request.Request(
        token_uri,
        data=payload,
        headers={"Content-Type": "application/x-www-form-urlencoded"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=15) as resp:
        dados_token = json.loads(resp.read().decode("utf-8"))

    salvar_json = {
        "token": dados_token.get("access_token", ""),
        "access_token": dados_token.get("access_token", ""),
        "refresh_token": dados_token.get("refresh_token", ""),
        "token_uri": token_uri,
        "client_id": client_id,
        "client_secret": client_secret,
        "scopes": SCOPES,
    }
    TOKEN_JSON_PATH.write_text(json.dumps(salvar_json, indent=2), encoding="utf-8")
    print("   ✅ 'token.json' gerado e salvo automaticamente!")
    return salvar_json["access_token"]


def obter_access_token_valido() -> str:
    """
    Garante um access_token válido:
    1. Tenta token.json (renovando via refresh_token se necessário)
    2. Tenta token.pickle (do seu script antigo)
    3. Se nenhum existir ou funcionar, abre o navegador para login OAuth2 automático!
    """
    cfg = obter_config_oauth()

    # 1. Tenta token.json
    if TOKEN_JSON_PATH.exists():
        dados = carregar_json_seguro(TOKEN_JSON_PATH) or {}
        access_token = dados.get("access_token") or dados.get("token") or ""
        refresh_token = dados.get("refresh_token") or ""
        client_id = dados.get("client_id") or cfg["client_id"]
        client_secret = dados.get("client_secret") or cfg["client_secret"]
        token_uri = dados.get("token_uri") or cfg["token_uri"]

        if access_token:
            # Testa se o token atual está vivo
            try:
                req = urllib.request.Request(
                    "https://www.googleapis.com/drive/v3/about?fields=user",
                    headers={"Authorization": f"Bearer {access_token}"}
                )
                with urllib.request.urlopen(req, timeout=8) as r:
                    if r.status == 200:
                        return access_token
            except Exception:
                pass

        if refresh_token:
            try:
                novo_token = renovar_access_token_http(refresh_token, client_id, client_secret, token_uri)
                if novo_token:
                    dados["access_token"] = novo_token
                    dados["token"] = novo_token
                    TOKEN_JSON_PATH.write_text(json.dumps(dados, indent=2), encoding="utf-8")
                    return novo_token
            except Exception:
                pass

    # 2. Tenta token.pickle antigo
    if TOKEN_PICKLE_PATH.exists():
        try:
            with open(TOKEN_PICKLE_PATH, "rb") as f_pk:
                creds = pickle.load(f_pk)
            if creds:
                if getattr(creds, "valid", False) and getattr(creds, "token", None):
                    return creds.token
                refresh_tk = getattr(creds, "refresh_token", None)
                if refresh_tk:
                    novo_token = renovar_access_token_http(
                        refresh_tk, cfg["client_id"], cfg["client_secret"], cfg["token_uri"]
                    )
                    if novo_token:
                        return novo_token
        except Exception:
            pass

    # 3. Inicia o login OAuth no navegador se estiver rodando no PC do usuário
    if localizar_diretorio_drive() is not None:
        try:
            return iniciar_login_oauth_navegador_puro()
        except Exception as e:
            print(f"   ⚠️ Não foi possível abrir o login OAuth no navegador: {e}")

    return ""


# ==============================================================================
# ☁️ GOOGLE DRIVE API V3: INDEXAÇÃO COMPLETA + PERMISSÃO PÚBLICA
# ==============================================================================
class GoogleDriveManager:
    def __init__(self, access_token: str):
        self.access_token = access_token
        self.por_pai_e_nome = {}       # (parent_id, nome_lower) -> file_id
        self.por_caminho = {}          # "cursos/🔶 kotlin/aula 1/arquivo.pdf" -> file_id
        self.por_nome_unico = {}       # nome_lower -> file_id
        self.todos_itens = {}          # file_id -> {id, name, parents, mimeType}
        self.pastas_publicas_ok = set()

    def ativo(self) -> bool:
        return bool(self.access_token)

    def _requisicao_json(self, url: str, metodo: str = "GET", corpo: dict = None) -> dict:
        headers = {"Authorization": f"Bearer {self.access_token}"}
        data = None
        if corpo is not None:
            headers["Content-Type"] = "application/json"
            data = json.dumps(corpo).encode("utf-8")
        req = urllib.request.Request(url, data=data, headers=headers, method=metodo)
        with urllib.request.urlopen(req, timeout=20) as resp:
            return json.loads(resp.read().decode("utf-8"))

    def carregar_todos_arquivos_em_lote(self):
        """
        Baixa todos os metadados do Drive em páginas de 1000 itens (leva ~3 a 5 segundos)
        e monta a árvore completa na memória para preencher 100% dos IDs.
        """
        if not self.ativo():
            return

        print("☁️ Baixando índice completo de IDs da API do Google Drive...")
        page_token = None
        total = 0

        try:
            while True:
                params = {
                    "pageSize": 1000,
                    "q": "trashed = false",
                    "fields": "nextPageToken, files(id, name, parents, mimeType)",
                    "supportsAllDrives": "true",
                    "includeItemsFromAllDrives": "true",
                }
                if page_token:
                    params["pageToken"] = page_token

                url = "https://www.googleapis.com/drive/v3/files?" + urllib.parse.urlencode(params)
                dados = self._requisicao_json(url)

                for item in dados.get("files", []):
                    fid = item.get("id", "")
                    nome = item.get("name", "")
                    parents = item.get("parents", [])
                    if not fid or not nome:
                        continue

                    self.todos_itens[fid] = item
                    nome_norm = normalizar_nome_arquivo(nome)
                    nome_limpo = normalizar_texto(nome)
                    self.por_nome_unico[nome_norm] = fid

                    for pid in parents:
                        self.por_pai_e_nome[(pid, nome_norm)] = fid
                        if nome_limpo:
                            self.por_pai_e_nome[(pid, nome_limpo)] = fid

                    total += 1

                page_token = dados.get("nextPageToken")
                if not page_token:
                    break

            # Constrói os caminhos relativos para casamento direto
            memo_caminho = {}

            def obter_caminho(fid, visitados=None):
                if fid in memo_caminho:
                    return memo_caminho[fid]
                if visitados is None:
                    visitados = set()
                if fid in visitados or fid not in self.todos_itens:
                    return ""
                visitados.add(fid)
                item = self.todos_itens[fid]
                nome = item.get("name", "")
                parents = item.get("parents", [])
                if not parents:
                    memo_caminho[fid] = nome
                    return nome
                caminho_pai = obter_caminho(parents[0], visitados)
                completo = f"{caminho_pai}/{nome}" if caminho_pai else nome
                memo_caminho[fid] = completo
                return completo

            for fid in self.todos_itens:
                cam = obter_caminho(fid)
                if cam:
                    cam_limpo = extrair_caminho_relativo_util(cam)
                    if cam_limpo:
                        self.por_caminho[cam_limpo.lower()] = fid

            print(f"   ✅ {total} arquivos/pastas sincronizados da nuvem do Google Drive!")
        except Exception as e:
            print(f"   ⚠️ Aviso ao listar arquivos em lote na API do Drive: {e}")

    def buscar_id_filho_direto_na_api(self, nome_item: str, parent_id: str) -> str:
        """
        Se algum arquivo recém-criado não estava no lote, faz uma busca cirúrgica
        exatamente dentro da pasta pai ('parent_id' in parents).
        """
        if not self.ativo() or not parent_id or not nome_item:
            return ""

        nome_norm = normalizar_nome_arquivo(nome_item)
        nome_limpo = normalizar_texto(nome_item)

        # 1. Verifica na tabela em memória
        achou = self.por_pai_e_nome.get((parent_id, nome_norm)) or self.por_pai_e_nome.get((parent_id, nome_limpo))
        if achou:
            return achou

        # 2. Consulta diretamente na API do Google Drive
        try:
            nome_escapado = nome_item.replace("\\", "\\\\").replace("'", "\\'")
            query = f"'{parent_id}' in parents and name = '{nome_escapado}' and trashed = false"
            params = {
                "q": query,
                "fields": "files(id, name)",
                "pageSize": 1,
                "supportsAllDrives": "true",
                "includeItemsFromAllDrives": "true",
            }
            url = "https://www.googleapis.com/drive/v3/files?" + urllib.parse.urlencode(params)
            dados = self._requisicao_json(url)
            arquivos = dados.get("files", [])
            if arquivos:
                fid = arquivos[0]["id"]
                self.por_pai_e_nome[(parent_id, nome_norm)] = fid
                return fid
        except Exception:
            pass

        return ""

    def tornar_item_publico(self, file_id: str) -> bool:
        """Define permissão pública ('anyone' -> 'reader') no item do Google Drive."""
        if not self.ativo() or not file_id or file_id in self.pastas_publicas_ok:
            return False
        try:
            url = f"https://www.googleapis.com/drive/v3/files/{file_id}/permissions?fields=id"
            self._requisicao_json(url, metodo="POST", corpo={"type": "anyone", "role": "reader"})
            self.pastas_publicas_ok.add(file_id)
            return True
        except Exception:
            self.pastas_publicas_ok.add(file_id)
            return False

    def tornar_arvore_de_pastas_publica(self, ids_pastas: list):
        """
        Garante que a pasta raiz, todos os Semestres, Cursos e Matérias estejam
        com permissão pública ('Qualquer pessoa com o link pode ler').
        No Google Drive, todas as aulas e arquivos dentro delas herdam isso automaticamente!
        """
        if not self.ativo() or not TORNAR_PASTAS_PUBLICAS_AUTOMATICAMENTE:
            return
        ids_unicos = [fid for fid in dict.fromkeys(ids_pastas) if fid and fid != "root"]
        if not ids_unicos:
            return

        print(f"🌍 Garantindo permissão pública na nuvem para {len(ids_unicos)} pastas principais...")
        liberados = 0
        with ThreadPoolExecutor(max_workers=10) as pool:
            futuros = [pool.submit(self.tornar_item_publico, fid) for fid in ids_unicos]
            for fut in as_completed(futuros):
                if fut.result():
                    liberados += 1
        print(f"   ✅ Permissões públicas confirmadas ({liberados} pastas atualizadas/verificadas)!")


# ==============================================================================
# 💻 LEITOR DO BANCO SQLITE LOCAL DO GOOGLE DRIVE DESKTOP (DRIVEFS) CORRIGIDO
# ==============================================================================
def extrair_caminho_relativo_util(caminho_completo: str) -> str:
    """
    Remove prefixos como 'Meu Drive/CienciaComputacao/' ou 'My Drive/CienciaComputacao/'
    para que o caminho comece exatamente em '1° semestre/...' ou 'Cursos/...'.
    """
    partes = [p for p in str(caminho_completo).replace("\\", "/").split("/") if p]
    for idx, parte in enumerate(partes):
        if eh_pasta_semestre_ou_cursos(parte):
            return "/".join(partes[idx:])
    return "/".join(partes)


def extrair_ids_drivefs_local() -> dict:
    """
    Lê o banco SQLite local do Google Drive Desktop (%LOCALAPPDATA%\\Google\\DriveFS)
    e retorna 3 mapas para nunca errar o casamento de IDs:
      - por_caminho: 'cursos/🔶 kotlin/aula 1/operation_kotlin.pdf' -> cloud_id
      - por_pai_e_nome: (parent_cloud_id, nome_lower) -> cloud_id
      - por_nome: 'operation_kotlin.pdf' -> cloud_id
    """
    resultado = {
        "por_caminho": {},
        "por_pai_e_nome": {},
        "por_nome": {},
    }
    local_app_data = os.environ.get("LOCALAPPDATA")
    if not local_app_data:
        return resultado

    drivefs_dir = Path(local_app_data) / "Google" / "DriveFS"
    if not drivefs_dir.exists():
        return resultado

    bancos = list(drivefs_dir.glob("*/metadata_sqlite_db")) + list(drivefs_dir.glob("*/mirror_metadata_sqlite.db"))
    if not bancos:
        return resultado

    for db_file in bancos:
        tmp_dir = Path(tempfile.mkdtemp(prefix="studyos_dfs_"))
        try:
            for sufixo in ("", "-wal", "-shm"):
                origem = Path(str(db_file) + sufixo)
                if origem.exists():
                    shutil.copy2(origem, tmp_dir / origem.name)

            copia_db = tmp_dir / db_file.name
            conn = sqlite3.connect(f"file:{copia_db.as_posix()}?mode=ro", uri=True)
            cur = conn.cursor()

            itens = {}
            parents = {}

            # Tenta os esquemas possíveis do Google Drive Desktop (DriveFS)
            consultas_possiveis = [
                """
                SELECT i.stable_id, i.cloud_id, i.local_title, p.parent_stable_id
                FROM items i
                LEFT JOIN stable_parents p ON i.stable_id = p.item_stable_id
                WHERE i.trashed = 0 AND i.cloud_id IS NOT NULL AND i.cloud_id != ''
                """,
                """
                SELECT stable_id, cloud_id, local_title, parent_stable_id
                FROM items
                WHERE trashed = 0 AND cloud_id IS NOT NULL AND cloud_id != ''
                """
            ]

            linhas = []
            for sql in consultas_possiveis:
                try:
                    cur.execute(sql)
                    linhas = cur.fetchall()
                    if linhas:
                        break
                except Exception:
                    continue

            for sid, cid, title, pid in linhas:
                if not cid or not title:
                    continue
                itens[sid] = (str(cid), str(title))
                if pid is not None:
                    parents[sid] = pid

            conn.close()

            memo_path = {}

            def montar_caminho(sid, visitados=None):
                if sid in memo_path:
                    return memo_path[sid]
                if visitados is None:
                    visitados = set()
                if sid in visitados or sid not in itens:
                    return ""
                visitados.add(sid)
                cid, title = itens[sid]
                pid = parents.get(sid)
                if pid and pid in itens:
                    pai = montar_caminho(pid, visitados)
                    cam = f"{pai}/{title}" if pai else title
                else:
                    cam = title
                memo_path[sid] = cam
                return cam

            for sid, (cid, title) in itens.items():
                nome_norm = normalizar_nome_arquivo(title)
                nome_limpo = normalizar_texto(title)
                resultado["por_nome"][nome_norm] = cid

                pid = parents.get(sid)
                if pid and pid in itens:
                    parent_cid = itens[pid][0]
                    resultado["por_pai_e_nome"][(parent_cid, nome_norm)] = cid
                    if nome_limpo:
                        resultado["por_pai_e_nome"][(parent_cid, nome_limpo)] = cid

                caminho_bruto = montar_caminho(sid)
                if caminho_bruto:
                    caminho_util = extrair_caminho_relativo_util(caminho_bruto)
                    resultado["por_caminho"][caminho_util.lower()] = cid
                    resultado["por_caminho"][normalizar_nome_arquivo(caminho_util)] = cid

            if resultado["por_caminho"]:
                print(f"⚡ DriveFS Local sincronizado: {len(itens)} IDs reais extraídos do Google Drive Desktop!")
                break
        except Exception:
            pass
        finally:
            shutil.rmtree(tmp_dir, ignore_errors=True)

    return resultado


# ==============================================================================
# 📓 MAPEAMENTO DO BACKUP DO NOTEBOOKLM E DB ANTERIOR
# ==============================================================================
APELIDOS_MATERIAS = {
    "vibecoding ui ux": "vibecoding ui ux",
    "vibecoding": "vibecoding ui ux",
    "social midia": "social midia",
    "social media": "social midia",
    "programacao orientada a objetos java": "programacao orientada a objetos java",
    "c tecnicas de desenvolvimento de algoritmos": "c tecnicas de desenvolvimento de algoritmos",
    "tecnicas de desenvolvimento de algoritmos": "c tecnicas de desenvolvimento de algoritmos",
}


def extrair_numeros_aula(titulo: str) -> tuple:
    texto_inicio = str(titulo).split("-")[0].split(":")[0]
    nums = tuple(int(n) for n in re.findall(r"\d+", texto_inicio))
    if nums:
        return nums
    return tuple(int(n) for n in re.findall(r"\d+", str(titulo)))


def eh_aula_conclusao(titulo: str) -> bool:
    return "conclusao" in normalizar_texto(titulo)


def carregar_mapa_notebooklm(backup_path: Path) -> list:
    if not backup_path.exists():
        candidatos = sorted(Path(".").glob("notebooklm_colecoes_BACKUP*.json"))
        if candidatos:
            backup_path = candidatos[-1]
        else:
            return []

    print(f"📓 Carregando últimos links do NotebookLM de: {backup_path.name}")
    colecoes_raw = carregar_json_seguro(backup_path) or []
    colecoes_processadas = []

    for idx, col in enumerate(colecoes_raw):
        raw_id = str(col.get("id", ""))
        drive_folder_id = raw_id.replace("folder_", "").strip()
        nome = str(col.get("name", "")).strip()
        emoji = str(col.get("emoji", "📘")).strip()
        norm_nome = APELIDOS_MATERIAS.get(normalizar_texto(nome), normalizar_texto(nome))

        eh_curso_extra = idx >= 19 or norm_nome in {
            "office 365", "java", "vibecoding ui ux", "social midia", "c++",
            "xml", "python", "php", "prompt engineering", "power bi", "excel",
            "typescript", "marketing", "power automate", "sql", "ciencia de dados",
            "inteligencia artificial", "c", "kotlin", "libras",
            "modelagem de processos", "android studio", "javascript", "power fx"
        }

        links_por_numero = {}
        link_conclusao = ""
        id_pasta_por_numero = {}

        for nb in col.get("notebooks", []):
            titulo_nb = str(nb.get("title", "")).strip()
            url_nb = str(nb.get("url", "")).strip()
            nb_id = str(nb.get("id", "")).strip()

            if eh_aula_conclusao(titulo_nb):
                if url_nb:
                    link_conclusao = url_nb
                continue

            nums = extrair_numeros_aula(titulo_nb)
            if nums:
                if url_nb:
                    links_por_numero[nums] = url_nb
                elif nums not in links_por_numero:
                    links_por_numero[nums] = ""

                if nb.get("sources") == "Falta Link" and nb_id and "?" not in nb_id and "-" not in nb_id[:8]:
                    id_pasta_por_numero[nums] = nb_id

        colecoes_processadas.append({
            "indice": idx,
            "driveId": drive_folder_id,
            "nome": nome,
            "emoji": emoji,
            "nomeComEmoji": f"{emoji} {nome}".strip(),
            "normNome": norm_nome,
            "ehCursoExtra": eh_curso_extra,
            "linksPorNumero": links_por_numero,
            "linkConclusao": link_conclusao,
            "idPastaPorNumero": id_pasta_por_numero,
        })

    return colecoes_processadas


def encontrar_colecao_notebooklm(nome_pasta: str, drive_id: str, eh_pasta_cursos: bool, colecoes: list):
    if drive_id:
        for col in colecoes:
            if col["driveId"] and col["driveId"] == drive_id:
                return col

    norm_pasta = APELIDOS_MATERIAS.get(normalizar_texto(nome_pasta), normalizar_texto(nome_pasta))

    if "c++" in norm_pasta:
        for col in colecoes:
            if col["normNome"] == "c++":
                return col
        return None

    for col in colecoes:
        if col["normNome"] == norm_pasta and col["ehCursoExtra"] == eh_pasta_cursos:
            return col

    for col in colecoes:
        if col["normNome"] == norm_pasta:
            return col

    return None


def obter_link_aula_da_colecao(nome_aula: str, colecao: dict) -> str:
    if not colecao or colecao["normNome"] == "c++":
        return ""
    if eh_aula_conclusao(nome_aula):
        return colecao.get("linkConclusao", "")
    nums = extrair_numeros_aula(nome_aula)
    if not nums:
        return ""
    links_map = colecao.get("linksPorNumero", {})
    if nums in links_map:
        return links_map[nums]
    if len(nums) == 1:
        n_unico = nums[0]
        for chave_nums, url in links_map.items():
            if n_unico in chave_nums and url:
                return url
    return ""


def _valor_placeholder_prof(val: str) -> bool:
    low = str(val or "").strip().lower()
    return not low or low in ("professor a definir", "curso livre / formação") or "por favor digite" in low


def _mesclar_node_cache(mapa: dict, chave, node: dict) -> None:
    if not isinstance(node, dict) or not chave:
        return
    atual = mapa.get(chave)
    if not isinstance(atual, dict):
        mapa[chave] = dict(node)
        return

    for k, v in node.items():
        if k in ("filhos",):
            continue
        if v is None or v == "":
            continue
        if k == "prof":
            if not _valor_placeholder_prof(v) or _valor_placeholder_prof(atual.get("prof", "")):
                atual[k] = v
        elif k == "id":
            if len(str(v)) > 10 and (not atual.get("id") or len(str(atual.get("id"))) <= 10):
                atual[k] = v
        elif k in ("atividades", "tags"):
            if isinstance(v, list) and len(v) > 0:
                atual[k] = v
        else:
            atual[k] = v


def indexar_db_existente(*dbs_antigos: dict) -> dict:
    cache = {
        "por_local": {},
        "por_nome_disciplina": {},
        "por_aula_e_arquivo": {},
        "por_disc_e_aula": {},
    }

    def percorrer(node, nome_disc="", nome_aula=""):
        if not isinstance(node, dict):
            return
        local_norm = str(node.get("local", "")).replace("\\", "/").strip("/")
        if local_norm:
            _mesclar_node_cache(cache["por_local"], local_norm, node)
            _mesclar_node_cache(cache["por_local"], local_norm.lower(), node)

        nome_atual = node.get("nome", "")
        if any(k in node for k in ("prof", "Status", "cover", "TAGS", "atividades")):
            norm_d = normalizar_texto(nome_atual)
            if norm_d:
                _mesclar_node_cache(cache["por_nome_disciplina"], norm_d, node)
            nome_disc = nome_atual
        elif node.get("tipo") == "pasta" and (
            "aula" in normalizar_texto(nome_atual) or "conclusao" in normalizar_texto(nome_atual)
        ):
            nome_aula = nome_atual
            if nome_disc:
                nums_k = (999,) if eh_aula_conclusao(nome_atual) else extrair_numeros_aula(nome_atual)
                chave_da = (normalizar_texto(nome_disc), nums_k)
                _mesclar_node_cache(cache["por_disc_e_aula"], chave_da, node)
        elif node.get("tipo") == "arquivo" and nome_atual:
            chave = (normalizar_texto(nome_disc), extrair_numeros_aula(nome_aula), normalizar_nome_arquivo(nome_atual))
            _mesclar_node_cache(cache["por_aula_e_arquivo"], chave, node)

        artifacts = node.get("artifacts")
        if isinstance(artifacts, dict):
            for art_item in artifacts.values():
                if not isinstance(art_item, dict):
                    continue
                art_local = str(art_item.get("local", "")).replace("\\", "/").strip("/")
                if art_local:
                    _mesclar_node_cache(cache["por_local"], art_local, art_item)
                    _mesclar_node_cache(cache["por_local"], art_local.lower(), art_item)
                art_nome = art_item.get("nome", "")
                if art_nome:
                    chave_art = (normalizar_texto(nome_disc), extrair_numeros_aula(nome_aula), normalizar_nome_arquivo(art_nome))
                    _mesclar_node_cache(cache["por_aula_e_arquivo"], chave_art, art_item)

        for filho in node.get("filhos", []):
            percorrer(filho, nome_disc, nome_aula)

    for db_item in dbs_antigos:
        if isinstance(db_item, dict) and db_item:
            percorrer(db_item)
    return cache


# ==============================================================================
# 🌳 RESOLUTOR UNIFICADO DE ID DO GOOGLE DRIVE (NUNCA DEIXA SEM ID)
# ==============================================================================
def resolver_id_item(
    nome_item: str,
    caminho_relativo: str,
    parent_drive_id: str,
    id_cache_antigo: str,
    id_backup_nb: str,
    drivefs_map: dict,
    drive_api: GoogleDriveManager,
) -> str:
    # 1. ID já existente no db.json antigo (se válido)
    if id_cache_antigo and len(str(id_cache_antigo)) > 10 and id_cache_antigo != "root":
        return str(id_cache_antigo)

    # 2. ID vindo do backup do NotebookLM
    if id_backup_nb and len(str(id_backup_nb)) > 10:
        return str(id_backup_nb)

    cam_lower = caminho_relativo.replace("\\", "/").strip("/").lower()
    nome_norm = normalizar_nome_arquivo(nome_item)
    nome_limpo = normalizar_texto(nome_item)

    # 3. Busca pelo Parent ID + Nome no DriveFS local (100% preciso)
    if parent_drive_id:
        id_dfs_pai = (
            drivefs_map["por_pai_e_nome"].get((parent_drive_id, nome_norm))
            or drivefs_map["por_pai_e_nome"].get((parent_drive_id, nome_limpo))
        )
        if id_dfs_pai:
            return id_dfs_pai

    # 4. Busca pelo caminho relativo no DriveFS local
    id_dfs_cam = (
        drivefs_map["por_caminho"].get(cam_lower)
        or drivefs_map["por_caminho"].get(normalizar_nome_arquivo(cam_lower))
    )
    if id_dfs_cam:
        return id_dfs_cam

    # 5. Busca na API do Google Drive pelo Parent ID + Nome (em memória ou consulta direta)
    if drive_api.ativo() and parent_drive_id:
        id_api_pai = drive_api.buscar_id_filho_direto_na_api(nome_item, parent_drive_id)
        if id_api_pai:
            return id_api_pai

    # 6. Busca na API do Google Drive pelo caminho relativo
    if drive_api.ativo():
        id_api_cam = drive_api.por_caminho.get(cam_lower)
        if id_api_cam:
            return id_api_cam

    # 7. Fallback por nome de arquivo único (se não for nome genérico como unnamed.png)
    nomes_genericos = {"unnamed.png", "unnamed (1).png", "unnamed (2).png", "unnamed (3).png", "unnamed (4).png", "aula 1.pdf", "aula 2.pdf"}
    if nome_norm not in nomes_genericos and not nome_norm.startswith("aula "):
        return drivefs_map["por_nome"].get(nome_norm) or drive_api.por_nome_unico.get(nome_norm) or ""

    return ""


# ==============================================================================
# 📂 ESCANEAMENTO DAS PASTAS DE AULAS, MATÉRIAS E CURSOS
# ==============================================================================
def escanear_pasta_aula(
    pasta_aula: Path,
    caminho_relativo_aula: str,
    nome_disciplina: str,
    parent_disc_id: str,
    colecao_nb: dict,
    cache_antigo: dict,
    drivefs_map: dict,
    drive_api: GoogleDriveManager,
    estatisticas: dict,
) -> dict:
    nums = extrair_numeros_aula(pasta_aula.name)
    nums_chave = (999,) if eh_aula_conclusao(pasta_aula.name) else nums
    chave_disc_aula = (normalizar_texto(nome_disciplina), nums_chave)
    nodo_antigo = (
        cache_antigo["por_local"].get(caminho_relativo_aula)
        or cache_antigo["por_local"].get(caminho_relativo_aula.lower())
        or cache_antigo["por_disc_e_aula"].get(chave_disc_aula)
        or {}
    )

    id_backup_aula = colecao_nb["idPastaPorNumero"].get(nums, "") if (colecao_nb and nums) else ""

    aula_id = resolver_id_item(
        nome_item=pasta_aula.name,
        caminho_relativo=caminho_relativo_aula,
        parent_drive_id=parent_disc_id,
        id_cache_antigo=nodo_antigo.get("id", ""),
        id_backup_nb=id_backup_aula,
        drivefs_map=drivefs_map,
        drive_api=drive_api,
    )

    if aula_id:
        estatisticas["ids_pastas_para_publicar"].append(aula_id)

    arquivos_nodos = []
    artifacts_aula = {}
    itens_ordenados = sorted(pasta_aula.iterdir(), key=lambda p: (not p.is_dir(), p.name.lower()))

    for item in itens_ordenados:
        if item.name.startswith(".") or item.name.lower() in ("desktop.ini", "thumbs.db"):
            continue

        rel_item = f"{caminho_relativo_aula}/{item.name}".replace("\\", "/")
        chave_cache_arq = (normalizar_texto(nome_disciplina), nums, normalizar_nome_arquivo(item.name))
        antigo_item = (
            cache_antigo["por_local"].get(rel_item)
            or cache_antigo["por_local"].get(rel_item.lower())
            or cache_antigo["por_aula_e_arquivo"].get(chave_cache_arq)
            or {}
        )

        if item.is_dir():
            sub_nodo = escanear_pasta_aula(
                item, rel_item, nome_disciplina, aula_id, None,
                cache_antigo, drivefs_map, drive_api, estatisticas
            )
            sub_artifacts = sub_nodo.pop("artifacts", None)
            if isinstance(sub_artifacts, dict):
                for role_key, role_val in sub_artifacts.items():
                    if role_key not in artifacts_aula:
                        artifacts_aula[role_key] = role_val
            for url_key in ("mindmapUrl", "flashcardsUrl", "quizUrl", "relatorioUrl"):
                sub_nodo.pop(url_key, None)
            arquivos_nodos.append(sub_nodo)
        else:
            item_id = resolver_id_item(
                nome_item=item.name,
                caminho_relativo=rel_item,
                parent_drive_id=aula_id,
                id_cache_antigo=antigo_item.get("id", ""),
                id_backup_nb="",
                drivefs_map=drivefs_map,
                drive_api=drive_api,
            )

            if item_id:
                estatisticas["arquivos_com_id"] += 1
            else:
                estatisticas["arquivos_sem_id"] += 1

            mime = detectar_mime_type(item)
            role_artefato = classificar_artefato_arquivo(item.name)
            arq_dict = {
                "nome": item.name,
                "tipo": "arquivo",
                "id": item_id,
                "mimeType": mime,
                "local": rel_item,
            }

            if item_id:
                arq_dict["link_web"] = f"https://drive.google.com/file/d/{item_id}/preview"

            # REGRA CRÍTICA Nº 1: Triagem estrita dos 4 novos artefatos sem sobrescrever Camada 1 (.md)
            # e sem enviar mapa-mental.json para os datasets brutos do Cofre Admin (Camada 11).
            if role_artefato == "mindmap":
                texto_json = ler_conteudo_markdown(item) or antigo_item.get("conteudoTexto", "")
                dados_json = ler_conteudo_json(item)
                if dados_json is None and isinstance(antigo_item.get("conteudoJson"), dict):
                    dados_json = antigo_item.get("conteudoJson")
                arq_dict["artifactRole"] = "mindmap"
                if texto_json:
                    arq_dict["conteudoTexto"] = texto_json
                if dados_json is not None:
                    arq_dict["conteudoJson"] = dados_json
                artifacts_aula["mindmap"] = arq_dict
                continue

            if role_artefato in ("flashcards", "quiz", "relatorio"):
                texto_art = ler_conteudo_markdown(item) or antigo_item.get("conteudoTexto", "")
                if role_artefato == "flashcards":
                    texto_art = limpar_flashcards_markdown_notebooklm(texto_art)
                arq_dict["artifactRole"] = role_artefato
                arq_dict["conteudoTexto"] = texto_art
                artifacts_aula[role_artefato] = arq_dict
                continue

            if role_artefato == "md_principal" or item.suffix.lower() in (".md", ".markdown"):
                texto_md = ler_conteudo_markdown(item) or antigo_item.get("conteudoTexto", "")
                arq_dict["conteudoTexto"] = texto_md
                titulo_h1 = extrair_titulo_h1_markdown(texto_md)
                if titulo_h1:
                    arq_dict["tituloH1"] = titulo_h1

            elif item.suffix.lower() == ".pdf":
                info_ocr = verificar_pdf_ocr(item, antigo_item)
                arq_dict["temOCR"] = info_ocr["temOCR"]
                arq_dict["statusOCR"] = info_ocr["statusOCR"]
                arq_dict["caracteresOCR"] = info_ocr["caracteresOCR"]

                estatisticas["total_pdfs"] += 1
                if info_ocr["temOCR"]:
                    estatisticas["com_ocr"] += 1
                else:
                    estatisticas["sem_ocr"] += 1
                    estatisticas["lista_sem_ocr"].append(rel_item)

            arquivos_nodos.append(arq_dict)

    link_nb = obter_link_aula_da_colecao(pasta_aula.name, colecao_nb)
    if not link_nb and nodo_antigo.get("linkNotebookLLM"):
        if not (colecao_nb and colecao_nb["normNome"] == "c++"):
            link_nb = nodo_antigo.get("linkNotebookLLM", "")

    aula_node = {
        "nome": pasta_aula.name,
        "tipo": "pasta",
        "id": aula_id,
        "local": caminho_relativo_aula,
        "filhos": arquivos_nodos,
        "linkNotebookLLM": link_nb,
    }

    for campo_meta in ("data_aula", "presenca", "revisao", "linkDrive", "linkGoogleDrive"):
        if campo_meta in nodo_antigo and nodo_antigo[campo_meta] is not None and nodo_antigo[campo_meta] != "":
            aula_node[campo_meta] = nodo_antigo[campo_meta]

    if artifacts_aula:
        aula_node["artifacts"] = artifacts_aula
        if "mindmap" in artifacts_aula:
            aula_node["mindmapUrl"] = artifacts_aula["mindmap"].get("local", "")
        if "flashcards" in artifacts_aula:
            aula_node["flashcardsUrl"] = artifacts_aula["flashcards"].get("local", "")
        if "quiz" in artifacts_aula:
            aula_node["quizUrl"] = artifacts_aula["quiz"].get("local", "")
        if "relatorio" in artifacts_aula:
            aula_node["relatorioUrl"] = artifacts_aula["relatorio"].get("local", "")

    return aula_node


def construir_disciplina_do_disco(
    pasta_disc: Path,
    nome_semestre: str,
    semestre_drive_id: str,
    eh_pasta_cursos: bool,
    colecoes_nb: list,
    cache_antigo: dict,
    drivefs_map: dict,
    drive_api: GoogleDriveManager,
    estatisticas: dict,
) -> dict:
    rel_disc = f"{nome_semestre}/{pasta_disc.name}".replace("\\", "/")
    norm_disc = normalizar_texto(pasta_disc.name)

    nodo_antigo = (
        cache_antigo["por_local"].get(rel_disc)
        or cache_antigo["por_local"].get(rel_disc.lower())
        or cache_antigo["por_nome_disciplina"].get(norm_disc)
        or {}
    )

    colecao_nb = encontrar_colecao_notebooklm(
        pasta_disc.name, nodo_antigo.get("id", ""), eh_pasta_cursos, colecoes_nb
    )

    drive_id_final = resolver_id_item(
        nome_item=pasta_disc.name,
        caminho_relativo=rel_disc,
        parent_drive_id=semestre_drive_id,
        id_cache_antigo=nodo_antigo.get("id", ""),
        id_backup_nb=colecao_nb["driveId"] if colecao_nb else "",
        drivefs_map=drivefs_map,
        drive_api=drive_api,
    )

    if drive_id_final:
        estatisticas["ids_pastas_para_publicar"].append(drive_id_final)

    nome_exibicao = pasta_disc.name
    if colecao_nb and colecao_nb["emoji"]:
        tem_emoji = any(
            ord(c) > 127000 or ord(c) in range(8500, 11000)
            for c in nome_exibicao[:3]
        )
        if not tem_emoji and not nome_exibicao.startswith("C "):
            nome_exibicao = f"{colecao_nb['emoji']} {nome_exibicao}"

    filhos_aulas = []
    for sub in sorted(pasta_disc.iterdir(), key=lambda p: p.name.lower()):
        if sub.name.startswith(".") or sub.name.lower() in ("desktop.ini", "thumbs.db"):
            continue
        rel_sub = f"{rel_disc}/{sub.name}".replace("\\", "/")
        if sub.is_dir():
            nodo_aula = escanear_pasta_aula(
                pasta_aula=sub,
                caminho_relativo_aula=rel_sub,
                nome_disciplina=pasta_disc.name,
                parent_disc_id=drive_id_final,
                colecao_nb=colecao_nb,
                cache_antigo=cache_antigo,
                drivefs_map=drivefs_map,
                drive_api=drive_api,
                estatisticas=estatisticas,
            )
            filhos_aulas.append(nodo_aula)

    filhos_aulas.sort(key=chave_ordenacao_aulas)

    prof_padrao = "Curso Livre / Formação" if eh_pasta_cursos else "Professor a definir"
    status_padrao = "andamento" if eh_pasta_cursos else "aprovado"
    tags_padrao = f"2026,{nome_semestre},Curso" if eh_pasta_cursos else f"2026,{nome_semestre}"

    disc_node = {
        "nome": nome_exibicao,
        "tipo": "pasta",
        "id": drive_id_final,
        "local": rel_disc,
        "filhos": filhos_aulas,
        "prof": nodo_antigo.get("prof") or prof_padrao,
        "Status": nodo_antigo.get("Status") or status_padrao,
        "cover": nodo_antigo.get("cover") or "",
        "TAGS": nodo_antigo.get("TAGS") or tags_padrao,
        "gemini": nodo_antigo.get("gemini") or "",
    }
    if nodo_antigo.get("status"):
        disc_node["status"] = nodo_antigo["status"]
    if isinstance(nodo_antigo.get("tags"), list) and nodo_antigo["tags"]:
        disc_node["tags"] = nodo_antigo["tags"]
    if isinstance(nodo_antigo.get("atividades"), list) and nodo_antigo["atividades"]:
        disc_node["atividades"] = nodo_antigo["atividades"]
    return disc_node


def localizar_diretorio_drive() -> Path:
    for caminho in CAMINHOS_DRIVE_POSSIVEIS:
        if caminho.exists() and caminho.is_dir():
            subpastas = [p.name for p in caminho.iterdir() if p.is_dir()]
            if any(eh_pasta_semestre_ou_cursos(nome) for nome in subpastas):
                return caminho
    return None


def main():
    inicio_t = time.time()
    print("=" * 78)
    print("🚀 STUDY OS V3 - GERADOR SUPREMO DO DB.JSON (100% IDS DRIVE + OCR + PÚBLICO)")
    print("=" * 78)
    print(f"🔍 Motor de verificação de OCR em PDF ativo: [{BIBLIOTECA_PDF.upper()}]")

    # 1. Carrega db.json anterior e mescla com o /db_json atual do Firebase (atividades, capas, datas)
    db_antigo = carregar_json_seguro(DB_ATUAL_PATH) or carregar_json_seguro(DB_FALLBACK_PATH) or {}
    db_firebase = carregar_db_firebase()
    cache_antigo = indexar_db_existente(db_antigo, db_firebase)

    # 2. Carrega backup do NotebookLM
    colecoes_nb = carregar_mapa_notebooklm(BACKUP_NOTEBOOKLM_PATH)

    # 3. Extrai IDs do banco SQLite local do Google Drive Desktop (DriveFS)
    drivefs_map = extrair_ids_drivefs_local()

    # 4. Autentica na API do Google Drive (gera token.json se necessário) e baixa todos os IDs
    access_token = obter_access_token_valido()
    drive_api = GoogleDriveManager(access_token)
    if drive_api.ativo():
        drive_api.carregar_todos_arquivos_em_lote()

    id_raiz_drive = db_antigo.get("id") or PASTA_RAIZ_ID_PADRAO

    estatisticas = {
        "total_pdfs": 0,
        "com_ocr": 0,
        "sem_ocr": 0,
        "lista_sem_ocr": [],
        "arquivos_com_id": 0,
        "arquivos_sem_id": 0,
        "ids_pastas_para_publicar": [id_raiz_drive],
    }

    pasta_drive = localizar_diretorio_drive()

    if pasta_drive:
        print(f"📂 Escaneando pastas diretamente do Google Drive: {pasta_drive}")
        pastas_raiz_nodos = []

        for pasta_top in sorted(pasta_drive.iterdir(), key=lambda p: p.name.lower()):
            if not pasta_top.is_dir() or pasta_top.name.startswith("."):
                continue

            if not eh_pasta_semestre_ou_cursos(pasta_top.name):
                print(f"   ⏭️ Ignorando pasta fora do escopo: {pasta_top.name}")
                continue

            eh_pasta_cursos = normalizar_texto(pasta_top.name) in ("cursos", "curso")
            print(f"   📁 Processando: {pasta_top.name}...")

            nodo_sem_antigo = (
                cache_antigo["por_local"].get(pasta_top.name)
                or cache_antigo["por_local"].get(pasta_top.name.lower())
                or {}
            )

            sem_id = resolver_id_item(
                nome_item=pasta_top.name,
                caminho_relativo=pasta_top.name,
                parent_drive_id=id_raiz_drive,
                id_cache_antigo=nodo_sem_antigo.get("id", ""),
                id_backup_nb="",
                drivefs_map=drivefs_map,
                drive_api=drive_api,
            )

            if sem_id:
                estatisticas["ids_pastas_para_publicar"].append(sem_id)

            disciplinas_nodos = []
            for pasta_disc in sorted(pasta_top.iterdir(), key=lambda p: p.name.lower()):
                if not pasta_disc.is_dir() or pasta_disc.name.startswith("."):
                    continue
                nodo_disc = construir_disciplina_do_disco(
                    pasta_disc=pasta_disc,
                    nome_semestre=pasta_top.name,
                    semestre_drive_id=sem_id,
                    eh_pasta_cursos=eh_pasta_cursos,
                    colecoes_nb=colecoes_nb,
                    cache_antigo=cache_antigo,
                    drivefs_map=drivefs_map,
                    drive_api=drive_api,
                    estatisticas=estatisticas,
                )
                disciplinas_nodos.append(nodo_disc)

            pastas_raiz_nodos.append({
                "nome": pasta_top.name,
                "tipo": "pasta",
                "id": sem_id,
                "local": pasta_top.name,
                "filhos": disciplinas_nodos,
            })

        pastas_raiz_nodos.sort(key=chave_ordenacao_pasta_raiz)

        # Garante que todas as pastas estejam públicas na nuvem para qualquer pessoa com o db.json acessar
        drive_api.tornar_arvore_de_pastas_publica(estatisticas["ids_pastas_para_publicar"])

        db_final = {
            "nome": "Raiz",
            "tipo": "pasta",
            "id": id_raiz_drive,
            "local": ".",
            "admin_gate": STUDIO_ADMIN_GATE,
            "atualizado_em": int(time.time() * 1000),
            "filhos": pastas_raiz_nodos,
        }
    else:
        print("⚠️ Pasta G:\\Meu Drive\\CienciaComputacao não encontrada montada.")
        db_final = db_antigo if isinstance(db_antigo, dict) else {}
        db_final["admin_gate"] = STUDIO_ADMIN_GATE
        db_final["atualizado_em"] = int(time.time() * 1000)

    atribuir_chaves_conteudo_db(db_final)
    DB_SAIDA_PATH.write_text(
        json.dumps(db_final, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    fb_enviado = enviar_db_para_firebase(db_final)

    duracao = time.time() - inicio_t
    total_materias = sum(len(s.get("filhos", [])) for s in db_final.get("filhos", []))
    total_aulas = sum(
        len(d.get("filhos", []))
        for s in db_final.get("filhos", [])
        for d in s.get("filhos", [])
    )

    print("\n" + "=" * 78)
    print(f"✅ ARQUIVO '{DB_SAIDA_PATH}' GERADO COM SUCESSO EM {duracao:.1f}s!")
    print("=" * 78)
    print(f"   • Total de Matérias / Cursos      : {total_materias}")
    print(f"   • Total de Aulas Mapeadas         : {total_aulas}")
    print(f"   • Arquivos com ID do Google Drive : {estatisticas['arquivos_com_id']} (Sem ID: {estatisticas['arquivos_sem_id']})")
    print(f"   • PDFs Verificados (OCR)          : {estatisticas['total_pdfs']} "
          f"(🔍 Com OCR: {estatisticas['com_ocr']} | 🖼️ Sem OCR: {estatisticas['sem_ocr']})")
    print(f"   • Sincronização Firebase /db_json : {'✅ Enviado' if fb_enviado else '⚠️ Pendente (verifique regras/secret Firebase)'}")
    print("=" * 78)


if __name__ == "__main__":
    main()