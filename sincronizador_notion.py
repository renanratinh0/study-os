# -*- coding: utf-8 -*-
"""
==============================================================================
🚀 STUDY OS - SINCRONIZADOR NOTION & FIREBASE (sincronizador_notion.py)
==============================================================================
Módulo autônomo, seguro e inteligente para conectar o Notion ao Study OS.

PRINCÍPIOS FUNDAMENTAIS:
1. 🛡️ O BANCO DE DADOS É SAGRADO:
   - Nunca sobrescreve ou apaga dados existentes.
   - Sempre enriquece onde faltar informação.
2. 🔀 DIVIDIR PARA CONQUISTAR:
   - /db_json: Árvore de arquivos do Google Drive (inalterada)
   - /fila_md: Fila de edições pendentes (inalterada)
   - /notion: Dados relacionais do Notion (Cursos, Controle de Aulas, Notas)
3. 🎯 MATCH DE NOMES INTELIGENTE:
   - Casa nomes com ou sem emojis (ex: '🎲 Big Data' == 'Big Data')
   - Desempata por semestre (ex: tag '6° semestre' == pasta '6° semestre')
4. 🖼️ ENRIQUECIMENTO BIDIRECIONAL DE METADADOS:
   - Banner/Cover: Se estiver no Notion e faltar no db.json -> preenche db.json.
   - Banner/Cover: Se faltar no Notion e estiver no db.json -> preenche Notion!
   - Professor(a): Se for placeholder no db.json -> assume o nome do Notion.
   - Status: Sincroniza Aprovado / Em andamento / DP.
5. 🎬 REPLICAÇÃO AUTOMÁTICA AULA POR AULA (PILOTO AUTOMÁTICO):
   - Avisa etapa por etapa no terminal: se a matéria estiver sem aula no Controle de Aulas,
     cria com emoji correto e deixa data vazia.
   - Procura o toggle H2 na página original do curso e garante o Synced Block original.
   - Cria o Synced Block espelhado na página do Controle de Aulas.
   - Injeta o conteúdo (Markdown formatado) + mídias do Google Drive (JPG, PNG, PDF sem OCR, MP4, M4A).
==============================================================================
"""

import os
import sys
import re
import json
import time
import unicodedata
import urllib.request
import urllib.error
import urllib.parse
from pathlib import Path

# Suporte a UTF-8 no terminal Windows PowerShell / CMD
if sys.platform == "win32":
    try:
        sys.stdout.reconfigure(encoding="utf-8")
        sys.stderr.reconfigure(encoding="utf-8")
    except Exception:
        pass

# ==============================================================================
# ⚙️ CONFIGURAÇÕES FIXAS DO WORKSPACE
# ==============================================================================
FIREBASE_URL = "https://study-os-fcc4a-default-rtdb.firebaseio.com"

# IDs das bases de dados no Notion
ID_DATABASE_CURSOS = "11d65e23-a26e-4be3-941e-4ce7681342ac"
ID_DATABASE_CONTROLE_AULAS = "ba190664-b676-45ef-a01a-cb8ed0d2e265"
ID_DATABASE_NOTAS = "c8391804-9897-4351-92ad-88dc3c8121aa"

SCRIPT_DIR = Path(__file__).resolve().parent
CONFIG_PATH = SCRIPT_DIR / "notion_config.json"
DB_JSON_PATH = SCRIPT_DIR / "db.json"


# ==============================================================================
# 🔐 GESTÃO DE CREDENCIAIS
# ==============================================================================
def obter_notion_token() -> str:
    """Busca o token do Notion no notion_config.json ou nas variáveis de ambiente."""
    token = os.getenv("NOTION_TOKEN") or os.getenv("NOTION_API_KEY")
    if token:
        return token.strip()

    if CONFIG_PATH.exists():
        try:
            with open(CONFIG_PATH, "r", encoding="utf-8") as f:
                cfg = json.load(f)
                token = cfg.get("notion_token") or cfg.get("token")
                if token:
                    return token.strip()
        except Exception as e:
            print(f"⚠️ Erro ao ler {CONFIG_PATH.name}: {e}")

    return ""


def salvar_notion_config(token: str):
    """Salva o token em notion_config.json para reutilização segura."""
    dados = {
        "notion_token": token.strip(),
        "database_cursos_id": ID_DATABASE_CURSOS,
        "database_controle_aulas_id": ID_DATABASE_CONTROLE_AULAS,
        "database_notas_id": ID_DATABASE_NOTAS,
        "firebase_url": FIREBASE_URL
    }
    with open(CONFIG_PATH, "w", encoding="utf-8") as f:
        json.dump(dados, f, indent=2, ensure_ascii=False)
    print(f"✅ Configurações salvas em: {CONFIG_PATH.name}")


# ==============================================================================
# 🧠 FUNÇÕES DE NORMALIZAÇÃO E MATCH INTELIGENTE
# ==============================================================================
STOP_WORDS_PT = {"de", "da", "do", "das", "dos", "em", "e", "para", "com", "a", "o", "as", "os", "ao", "aos"}


def normalizar_texto(texto: str) -> str:
    """Remove emojis, acentos, pontuações e espaços extras, preservando símbolos essenciais (C++, C#)."""
    if not texto:
        return ""
    s = str(texto).replace("++", "plusplus").replace("+", "plus").replace("#", "sharp")
    sem_acento = "".join(
        c for c in unicodedata.normalize("NFD", s)
        if unicodedata.category(c) != "Mn"
    )
    limpo = re.sub(r'[^a-zA-Z0-9]+', '', sem_acento).strip().lower()
    return limpo


def tokenizar_texto(texto: str, remover_stopwords: bool = False) -> set:
    """Extrai palavras normalizadas preservando símbolos de linguagens (C++, C#)."""
    if not texto:
        return set()
    s = str(texto).replace("++", "plusplus").replace("+", "plus").replace("#", "sharp")
    sem_acento = "".join(
        c for c in unicodedata.normalize("NFD", s)
        if unicodedata.category(c) != "Mn"
    )
    palavras = re.sub(r'[^a-zA-Z0-9]+', ' ', sem_acento).lower().split()
    if remover_stopwords:
        palavras = [p for p in palavras if p not in STOP_WORDS_PT]
    return set(palavras)


def extrair_icone_e_nome(nome_cru: str) -> tuple:
    """Separa o emoji e o nome limpo de uma pasta ou matéria."""
    str_val = str(nome_cru or "").strip()
    if not str_val:
        return ("📘", "")

    match_emoji = re.match(r'^([\U00010000-\U0010ffff]|\u2600-\u27bf|\ud83c[\udf00-\udfff]|\ud83d[\ud000-\ude4f]|\ud83d[\ude80-\udeff]|\ud83e[\udd00-\uddff])+\s*(.*)$', str_val)
    if match_emoji:
        emoji = match_emoji.group(1).strip()
        resto = match_emoji.group(2).strip()
        return (emoji, resto if resto else str_val)

    return ("📘", str_val)


def extrair_numero_aula(nome_aula: str):
    """Extrai o número da aula para casamento exato."""
    nome_norm = str(nome_aula or "").strip().lower()
    if "conclus" in nome_norm:
        return 999  # Código de conclusão
    match_num = re.search(r'(\d+)', nome_norm)
    if match_num:
        return int(match_num.group(1))
    return None


def formatar_titulo_controle_aula(nome_materia: str, num_aula: int) -> str:
    """Formata o título padrão para o banco Controle de Aulas."""
    _, nome_limpo = extrair_icone_e_nome(nome_materia)
    if num_aula == 999:
        return f"Aula de Conclusão {nome_limpo}"
    return f"{num_aula}° {nome_limpo} Aula"


def casar_materia_notion_com_db(materia_notion: dict, lista_materias_db: list) -> dict:
    """
    Encontra a matéria correspondente no db.json aplicando Match Inteligente por Score:
    1. Match exato de nome normalizado (1000 pts)
    2. Conjunto idêntico de palavras completas (800 pts)
    3. Subconjunto de palavras completas sem stopwords (400-600 pts, ex: 'Circuitos lógicos' em 'Circuitos lógicos (EAD)')
    4. Fallback de substring contida COM proteção de proporção de tamanho >= 0.70 (evita Java x JavaScript, C x C++)
    5. Bônus de desempate por semestre (+50 pts)
    """
    nome_notion_cru = materia_notion.get("nome", "")
    _, nome_notion_limpo = extrair_icone_e_nome(nome_notion_cru)
    nome_notion_norm = normalizar_texto(nome_notion_limpo)
    if not nome_notion_norm:
        return None

    tokens_notion_completos = tokenizar_texto(nome_notion_limpo, remover_stopwords=False)
    tokens_notion_sem_stop = tokenizar_texto(nome_notion_limpo, remover_stopwords=True)
    tags_notion = [normalizar_texto(t) for t in materia_notion.get("ano_tags", [])]

    candidatos_com_score = []

    for item in lista_materias_db:
        nome_db = item.get("nome", "")
        _, nome_db_limpo = extrair_icone_e_nome(nome_db)
        nome_db_norm = normalizar_texto(nome_db_limpo)
        tokens_db_completos = tokenizar_texto(nome_db_limpo, remover_stopwords=False)
        tokens_db_sem_stop = tokenizar_texto(nome_db_limpo, remover_stopwords=True)
        caminho_local = normalizar_texto(item.get("local", ""))

        score = 0

        # 1. Match exato total
        if nome_notion_norm == nome_db_norm:
            score = 1000
        # 2. Conjunto idêntico de palavras completas
        elif tokens_notion_completos == tokens_db_completos:
            score = 800
        # 3. Subconjunto de palavras completas (ex: 'Circuitos lógicos' dentro de 'Circuitos lógicos (EAD)')
        elif tokens_notion_sem_stop and tokens_db_sem_stop:
            intersecao = tokens_notion_sem_stop & tokens_db_sem_stop
            uniao = tokens_notion_sem_stop | tokens_db_sem_stop
            jaccard = len(intersecao) / len(uniao) if uniao else 0

            # Subconjunto estrito de palavras significativas
            if tokens_notion_sem_stop.issubset(tokens_db_sem_stop) or tokens_db_sem_stop.issubset(tokens_notion_sem_stop):
                razao_sub = len(intersecao) / max(len(tokens_notion_sem_stop), len(tokens_db_sem_stop))
                if razao_sub >= 0.5:
                    score = 400 + int(jaccard * 200)
            elif jaccard >= 0.65:
                score = 200 + int(jaccard * 100)

        # 4. Fallback de substring contida (MAS APENAS se razão de tamanho for >= 0.70)
        # Protege contra o clássico falso positivo Java x JavaScript (4/10 = 0.40) e C x C++ (1/3 = 0.33)
        elif nome_notion_norm in nome_db_norm or nome_db_norm in nome_notion_norm:
            tam_menor = min(len(nome_notion_norm), len(nome_db_norm))
            tam_maior = max(len(nome_notion_norm), len(nome_db_norm))
            razao = tam_menor / tam_maior if tam_maior else 0
            if razao >= 0.70:
                score = 100 + int(razao * 100)

        if score > 0:
            # Bônus de semestre
            for t in tags_notion:
                if t and t in caminho_local:
                    score += 50
                    break
            candidatos_com_score.append((score, item))

    if not candidatos_com_score:
        return None

    # Ordena pelo maior score decrescente
    candidatos_com_score.sort(key=lambda x: x[0], reverse=True)
    return candidatos_com_score[0][1]


# ==============================================================================
# 🌐 CLIENTE NOTION API REST (NATIVO)
# ==============================================================================
def notion_request(endpoint: str, method: str = "GET", payload: dict = None, token: str = None) -> dict:
    """Realiza requisição segura para a API v1 do Notion usando urllib."""
    if not token:
        token = obter_notion_token()
    if not token:
        raise ValueError("Token do Notion não configurado. Defina em notion_config.json ou na variável NOTION_TOKEN.")

    url = f"https://api.notion.com/v1/{endpoint.lstrip('/')}"
    headers = {
        "Authorization": f"Bearer {token}",
        "Notion-Version": "2022-06-28",
        "Content-Type": "application/json",
        "User-Agent": "StudyOS-NotionSync/2.0"
    }

    body = json.dumps(payload, ensure_ascii=False).encode("utf-8") if payload is not None else None
    req = urllib.request.Request(url, data=body, headers=headers, method=method)

    for tentativa in range(3):
        try:
            with urllib.request.urlopen(req, timeout=30) as resp:
                raw = resp.read().decode("utf-8")
                return json.loads(raw) if raw else {}
        except urllib.error.HTTPError as err:
            err_body = err.read().decode("utf-8", errors="replace")
            if err.code == 429:
                wait_time = int(err.headers.get("Retry-After", 2))
                time.sleep(wait_time)
                continue
            raise RuntimeError(f"Erro Notion API [{err.code}]: {err_body}")
        except Exception as e:
            if tentativa == 2:
                raise e
            time.sleep(1.5)

    return {}


def notion_buscar_paginas(token: str = None, filter_obj: dict = None) -> list:
    """Busca páginas no Notion via POST /v1/search com paginação completa."""
    payload = {"page_size": 100}
    if filter_obj:
        payload["filter"] = filter_obj

    resultados = []
    cursor = None
    while True:
        if cursor:
            payload["start_cursor"] = cursor
        resp = notion_request("search", method="POST", payload=payload, token=token)
        resultados.extend(resp.get("results", []))
        if not resp.get("has_more"):
            break
        cursor = resp.get("next_cursor")
    return resultados


def notion_listar_filhos(block_id: str, token: str = None) -> list:
    """Lista todos os blocos filhos com paginação automática."""
    blocos = []
    cursor = None
    while True:
        endpoint = f"blocks/{block_id}/children?page_size=100"
        if cursor:
            endpoint += f"&start_cursor={cursor}"
        resp = notion_request(endpoint, method="GET", token=token)
        blocos.extend(resp.get("results", []))
        if not resp.get("has_more"):
            break
        cursor = resp.get("next_cursor")
    return blocos


def notion_anexar_blocos(block_id: str, children: list, token: str = None) -> dict:
    """Anexa blocos filhos a um bloco existente (em lotes de até 100 blocos)."""
    if not children:
        return {}

    endpoint = f"blocks/{block_id}/children"
    lote_tamanho = 40
    ultimo_resp = {}
    for i in range(0, len(children), lote_tamanho):
        lote = children[i:i + lote_tamanho]
        ultimo_resp = notion_request(endpoint, method="PATCH", payload={"children": lote}, token=token)
    return ultimo_resp


def notion_atualizar_pagina(page_id: str, propriedades: dict = None, cover_url: str = None, icon_emoji: str = None, token: str = None) -> dict:
    """Atualiza propriedades, banner (cover) ou ícone de uma página no Notion com segurança."""
    payload = {}
    if propriedades:
        payload["properties"] = propriedades
    if cover_url:
        payload["cover"] = {"type": "external", "external": {"url": cover_url}}
    if icon_emoji:
        payload["icon"] = {"type": "emoji", "emoji": icon_emoji}

    if not payload:
        return {}

    endpoint = f"pages/{page_id}"
    return notion_request(endpoint, method="PATCH", payload=payload, token=token)


def notion_criar_pagina(parent_db_id: str, propriedades: dict, icon_emoji: str = None, token: str = None) -> dict:
    """Cria uma nova página em um banco de dados do Notion."""
    payload = {
        "parent": {"database_id": parent_db_id},
        "properties": propriedades
    }
    if icon_emoji:
        payload["icon"] = {"type": "emoji", "emoji": icon_emoji}
    return notion_request("pages", method="POST", payload=payload, token=token)


def notion_deletar_bloco(block_id: str, token: str = None) -> dict:
    """Deleta um bloco existente pelo ID (move para a lixeira do Notion)."""
    return notion_request(f"blocks/{block_id}", method="DELETE", token=token)


def notion_limpar_filhos_bloco(block_id: str, token: str = None) -> int:
    """Remove com segurança todos os blocos filhos de um bloco pai (ex: Synced Block)."""
    filhos = notion_listar_filhos(block_id, token=token)
    for f in filhos:
        try:
            notion_deletar_bloco(f["id"], token=token)
        except Exception:
            pass
    return len(filhos)



# ==============================================================================
# 🔥 CLIENTE FIREBASE RTDB (NATIVO)
# ==============================================================================
def firebase_put(caminho: str, dados) -> bool:
    """Grava ou sobrescreve um nó no Firebase RTDB."""
    url = f"{FIREBASE_URL}/{caminho.strip('/')}.json"
    body = json.dumps(dados, ensure_ascii=False).encode("utf-8")
    req = urllib.request.Request(url, data=body, headers={"Content-Type": "application/json"}, method="PUT")
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            return resp.status in (200, 204)
    except Exception as e:
        print(f"⚠️ Erro ao gravar Firebase ({caminho}): {e}")
        return False


# ==============================================================================
# 🧩 CONVERSOR: MARKDOWN -> BLOCOS RICOS NOTION (INTELIGENTE)
# ==============================================================================
def desescapar_markdown(texto: str) -> str:
    """
    Higieniza e desescapa o Markdown oriundo do db.json antes de converter em blocos Notion.
    Remove barras invertidas indevidas que quebram a renderização (#, *, _, [, ], ., -, +, `, &).
    Converte entidades HTML em caracteres reais.
    """
    if not texto:
        return ""

    # 1. Remove cabeçalho YAML frontmatter se houver
    texto = re.sub(r'^---[\s\S]*?---\s*', '', texto, flags=re.MULTILINE)

    # 2. Converte entidades HTML comuns
    texto = texto.replace("&#x20;", " ")
    texto = texto.replace("&nbsp;", " ")
    texto = texto.replace("&amp;", "&")
    texto = texto.replace("&lt;", "<")
    texto = texto.replace("&gt;", ">")
    texto = texto.replace("&quot;", '"')

    # 3. Desescapa caracteres padrão de Markdown (\#, \*, \_, \[, \], \(, \), \., \-, \+, \`, \!, \&)
    texto = re.sub(r'\\([#\*\-_\[\]\(\)\.\+`!>|&])', r'\1', texto)

    # 4. Remove barras invertidas soltas no início de linha
    texto = re.sub(r'^\s*\\+(?=\s|\w)', '', texto, flags=re.MULTILINE)

    return texto


def texto_para_rich_text(texto: str) -> list:
    """Converte markdown inline em rich_text Notion estruturado (bold, italic, code, equations)."""
    if not texto:
        return []

    # Proteção de limite do Notion: max 2000 chars por elemento rich_text
    if len(texto) > 1800:
        fatias = [texto[i:i + 1800] for i in range(0, len(texto), 1800)]
        resultado = []
        for f in fatias:
            resultado.extend(texto_para_rich_text(f))
        return resultado

    # Regex para tokens: negrito+itálico (***...***), negrito (**...**), código (`...`), link ([...](...)), equação ($...$), itálico (*...*)
    padrao = r'(\*\*\*[^\*]+?\*\*\*|\*\*[^\*]+?\*\*|`[^`]+?`|\[[^\]]+?\]\([^\)]+?\)|\$[^\$]+?\$|\*[^\*]+?\*)'
    tokens = re.split(padrao, texto)
    rich_text = []

    for t in tokens:
        if not t:
            continue
        if t.startswith('***') and t.endswith('***') and len(t) >= 6:
            rich_text.append({
                "type": "text",
                "text": {"content": t[3:-3]},
                "annotations": {"bold": True, "italic": True}
            })
        elif t.startswith('**') and t.endswith('**') and len(t) >= 4:
            rich_text.append({
                "type": "text",
                "text": {"content": t[2:-2]},
                "annotations": {"bold": True}
            })
        elif t.startswith('*') and t.endswith('*') and len(t) >= 2:
            rich_text.append({
                "type": "text",
                "text": {"content": t[1:-1]},
                "annotations": {"italic": True}
            })
        elif t.startswith('`') and t.endswith('`') and len(t) >= 2:
            rich_text.append({
                "type": "text",
                "text": {"content": t[1:-1]},
                "annotations": {"code": True}
            })
        elif t.startswith('$') and t.endswith('$') and len(t) >= 2:
            rich_text.append({
                "type": "equation",
                "equation": {"expression": t[1:-1]}
            })
        elif t.startswith('[') and '](' in t and t.endswith(')'):
            idx = t.index('](')
            rotulo = t[1:idx]
            url = t[idx + 2:-1]
            rich_text.append({
                "type": "text",
                "text": {"content": rotulo, "link": {"url": url}}
            })
        else:
            rich_text.append({
                "type": "text",
                "text": {"content": t}
            })

    return rich_text if rich_text else [{"type": "text", "text": {"content": texto}}]


# Conjunto exato de linguagens aceitas pela API do Notion (evita erro 400 validation_error)
NOTION_VALID_LANGUAGES = {
    "abap", "abc", "agda", "arduino", "ascii art", "assembly", "bash", "basic", "bnf",
    "c", "c#", "c++", "clojure", "coffeescript", "coq", "css", "dart", "dhall", "diff",
    "docker", "ebnf", "elixir", "elm", "erlang", "f#", "flow", "fortran", "gherkin", "glsl",
    "go", "graphql", "groovy", "haskell", "hcl", "html", "idris", "java", "javascript",
    "json", "julia", "kotlin", "latex", "less", "lisp", "livescript", "llvm ir", "lua",
    "makefile", "markdown", "markup", "matlab", "mathematica", "mermaid", "nix",
    "notion formula", "objective-c", "ocaml", "pascal", "perl", "php", "plain text",
    "powershell", "prolog", "protobuf", "purescript", "python", "r", "racket", "reason",
    "ruby", "rust", "sass", "scala", "scheme", "scss", "shell", "smalltalk", "solidity",
    "sql", "swift", "toml", "typescript", "vb.net", "verilog", "vhdl", "visual basic",
    "webassembly", "xml", "yaml", "java/c/c++/c#"
}

LANGUAGE_ALIASES = {
    "cpp": "c++",
    "cplusplus": "c++",
    "cs": "c#",
    "csharp": "c#",
    "py": "python",
    "py3": "python",
    "js": "javascript",
    "ts": "typescript",
    "sh": "bash",
    "shell": "bash",
    "zsh": "bash",
    "yml": "yaml",
    "md": "markdown",
    "txt": "plain text",
    "text": "plain text",
    "none": "plain text",
    "pseudo": "plain text",
    "portugol": "plain text",
    "": "plain text"
}


def mapear_linguagem_notion(lang_cru: str) -> str:
    """Mapeia o identificador de linguagem para uma opção válida do Notion, com fallback seguro para 'plain text'."""
    l = str(lang_cru or "").strip().lower()
    if l in LANGUAGE_ALIASES:
        l = LANGUAGE_ALIASES[l]
    if l in NOTION_VALID_LANGUAGES:
        return l
    return "plain text"


def auditar_markdown(conteudo_md: str, nome_aula: str = "") -> list:
    """
    Audita o arquivo Markdown e identifica inconsistências estruturais:
    - Blocos de código ``` abertos mas não fechados
    - Barras invertidas no início de títulos ou listas
    - Arquivo vazio
    """
    avisos = []
    if not conteudo_md or not conteudo_md.strip():
        avisos.append("⚠️ Arquivo Markdown vazio ou sem texto legível.")
        return avisos

    linhas = conteudo_md.splitlines()
    in_code = False
    linha_inicio_code = 0
    lang_code = ""

    for idx, linha in enumerate(linhas, 1):
        l = linha.strip()
        if l.startswith("```"):
            if not in_code:
                in_code = True
                linha_inicio_code = idx
                lang_code = l[3:].strip()
            else:
                in_code = False
        elif not in_code:
            if l.startswith(r"\#") or l.startswith(r"\*") or l.startswith(r"\-") or l.startswith(r"\ "):
                avisos.append(f"Linha {idx}: escape indevido detectado ('{l[:35]}...').")

    if in_code:
        avisos.append(f"Linha {linha_inicio_code}: Bloco de código ```{lang_code} aberto mas não fechado antes do fim do arquivo.")

    return avisos


def markdown_para_blocos_notion(conteudo_md: str) -> list:
    """
    Converte conteúdo Markdown limpo e higienizado na árvore de blocos padrão do Notion.
    Suporta:
    - Blocos de Código cercados por ``` (code fences com linguagem detectada: c++, python, etc.)
    - Tabelas Markdown (| col | col |)
    - Cabeçalhos H1, H2, H3
    - Listas com marcadores (*, -, +) e numeradas (1.)
    - Checklists / To-do ([ ], [x])
    - Citações / Quotes (> )
    - Divisores / Linhas horizontais (---, ***)
    - Parágrafos comuns com inline formatting (negrito, itálico, código inline, equações)
    """
    texto_limpo = desescapar_markdown(conteudo_md)
    linhas = texto_limpo.splitlines()
    blocos = []

    i = 0
    total_linhas = len(linhas)

    while i < total_linhas:
        linha_original = linhas[i]
        l = linha_original.strip()

        if not l:
            i += 1
            continue

        # 1. BLOCOS DE CÓDIGO COM CERCA (```linguagem ... ```)
        if l.startswith("```"):
            lang = l[3:].strip().lower()
            notion_lang = mapear_linguagem_notion(lang)

            # Acumula linhas de código até o fechamento com ```
            code_lines = []
            i += 1
            while i < total_linhas and not linhas[i].strip().startswith("```"):
                code_lines.append(linhas[i])
                i += 1

            if i < total_linhas and linhas[i].strip().startswith("```"):
                i += 1  # consome o fechamento

            code_text = "\n".join(code_lines)
            if not code_text.strip():
                continue

            # Divide em fatias seguras de 1900 caracteres para respeitar o limite Notion (2000)
            rich_chunks = []
            while code_text:
                chunk = code_text[:1900]
                code_text = code_text[1900:]
                rich_chunks.append({"type": "text", "text": {"content": chunk}})

            blocos.append({
                "type": "code",
                "code": {
                    "rich_text": rich_chunks,
                    "language": notion_lang
                }
            })
            continue

        # 2. TABELAS MARKDOWN (| Col 1 | Col 2 |)
        if l.startswith("|") and l.endswith("|") and i + 1 < total_linhas and re.search(r'\|\s*[-:]+[-| :]*\|', linhas[i + 1]):
            tabela_linhas = []
            while i < total_linhas and linhas[i].strip().startswith("|") and linhas[i].strip().endswith("|"):
                tabela_linhas.append(linhas[i].strip())
                i += 1

            if len(tabela_linhas) >= 2:
                header_raw = [c.strip() for c in tabela_linhas[0].strip("|").split("|")]
                largura = len(header_raw)
                # Pula a linha 1 (divisor |---|---|)
                rows_dados = tabela_linhas[2:]

                children_rows = []
                # Header row
                children_rows.append({
                    "type": "table_row",
                    "table_row": {
                        "cells": [texto_para_rich_text(c) for c in header_raw]
                    }
                })
                # Data rows
                for r_str in rows_dados:
                    celulas = [c.strip() for c in r_str.strip("|").split("|")]
                    # Normaliza largura
                    while len(celulas) < largura:
                        celulas.append("")
                    celulas = celulas[:largura]
                    children_rows.append({
                        "type": "table_row",
                        "table_row": {
                            "cells": [texto_para_rich_text(c) for c in celulas]
                        }
                    })

                blocos.append({
                    "type": "table",
                    "table": {
                        "table_width": largura,
                        "has_column_header": True,
                        "has_row_header": False,
                        "children": children_rows
                    }
                })
                continue

        # 3. LINHA HORIZONTAL / DIVISOR
        if re.match(r'^[-*_]{3,}$', l):
            blocos.append({"type": "divider", "divider": {}})
            i += 1
            continue

        # 4. CABEÇALHOS
        if l.startswith("# "):
            blocos.append({
                "type": "heading_1",
                "heading_1": {"rich_text": texto_para_rich_text(l[2:].strip())}
            })
            i += 1
            continue
        elif l.startswith("## "):
            blocos.append({
                "type": "heading_2",
                "heading_2": {"rich_text": texto_para_rich_text(l[3:].strip())}
            })
            i += 1
            continue
        elif l.startswith("### "):
            blocos.append({
                "type": "heading_3",
                "heading_3": {"rich_text": texto_para_rich_text(l[4:].strip())}
            })
            i += 1
            continue
        elif l.startswith("#### "):
            blocos.append({
                "type": "heading_3",
                "heading_3": {"rich_text": texto_para_rich_text(l[5:].strip())}
            })
            i += 1
            continue

        # 5. CHECKLISTS / TO-DO
        if re.match(r'^[-*+]?\s*\[([ xX])\]\s+(.*)', l):
            m = re.match(r'^[-*+]?\s*\[([ xX])\]\s+(.*)', l)
            marcado = m.group(1).lower() == 'x'
            txt = m.group(2)
            blocos.append({
                "type": "to_do",
                "to_do": {
                    "rich_text": texto_para_rich_text(txt),
                    "checked": marcado
                }
            })
            i += 1
            continue

        # 6. CITAÇÕES / QUOTES
        if l.startswith("> "):
            blocos.append({
                "type": "quote",
                "quote": {"rich_text": texto_para_rich_text(l[2:].strip())}
            })
            i += 1
            continue

        # 7. LISTAS COM MARCADORES (*, -, +)
        if re.match(r'^[-*+]\s+(.*)', l):
            txt = re.match(r'^[-*+]\s+(.*)', l).group(1)
            blocos.append({
                "type": "bulleted_list_item",
                "bulleted_list_item": {"rich_text": texto_para_rich_text(txt)}
            })
            i += 1
            continue

        # 8. LISTAS NUMERADAS (1., 2., etc.)
        if re.match(r'^\d+[\.)]\s+(.*)', l):
            txt = re.match(r'^\d+[\.)]\s+(.*)', l).group(1)
            blocos.append({
                "type": "numbered_list_item",
                "numbered_list_item": {"rich_text": texto_para_rich_text(txt)}
            })
            i += 1
            continue

        # 9. PARÁGRAFO COMUM
        blocos.append({
            "type": "paragraph",
            "paragraph": {"rich_text": texto_para_rich_text(l)}
        })
        i += 1

    return blocos


# ==============================================================================
# 🎬 CLASSIFICAÇÃO E BLOCOS DE MÍDIA DO GOOGLE DRIVE
# ==============================================================================
def classificar_midias_drive(arquivos: list) -> list:
    """
    Filtra e classifica rigorosamente os arquivos do Google Drive na ordem exigida:
    1º 📱 JPG (.jpg, .jpeg)
    2º 🖼️ PNG (.png, .webp, .gif, .svg)
    3º 📄 PDF Sem OCR (Apenas PDFs com statusOCR == 'sem_ocr' ou temOCR == False)
    4º 🎬 MP4 (.mp4, .mkv, .webm, .mov)
    5º 🎧 M4A (.m4a, .mp3, .wav, .aac, .ogg)

    * PDFs com OCR são descartados automaticamente conforme regra visual do Study OS.
    """
    jpgs = []
    pngs = []
    pdfs_sem_ocr = []
    mp4s = []
    m4as = []

    for arq in arquivos:
        nome = arq.get("nome", "")
        mime = arq.get("mimeType", "").lower()
        id_drive = arq.get("id", "")
        if not id_drive:
            continue

        ext = Path(nome).suffix.lower()

        # 1. JPG
        if ext in (".jpg", ".jpeg") or "jpeg" in mime or "jpg" in mime:
            jpgs.append(arq)
        # 2. PNG
        elif ext in (".png", ".webp", ".gif", ".svg") or "png" in mime:
            pngs.append(arq)
        # 3. PDF Sem OCR
        elif ext == ".pdf" or "pdf" in mime:
            tem_ocr = arq.get("temOCR")
            status_ocr = arq.get("statusOCR", "").lower()
            if status_ocr == "sem_ocr" or tem_ocr is False:
                pdfs_sem_ocr.append(arq)
            elif status_ocr == "com_ocr" or tem_ocr is True:
                # Ocultado conforme regra (PDF com OCR não vai para a galeria visual de slides)
                continue
            else:
                pdfs_sem_ocr.append(arq)
        # 4. MP4
        elif ext in (".mp4", ".mkv", ".webm", ".mov") or "video" in mime:
            mp4s.append(arq)
        # 5. M4A
        elif ext in (".m4a", ".mp3", ".wav", ".ogg", ".aac") or "audio" in mime:
            m4as.append(arq)

    # Ordenação alfabética interna dentro de cada grupo
    jpgs.sort(key=lambda x: x.get("nome", "").lower())
    pngs.sort(key=lambda x: x.get("nome", "").lower())
    pdfs_sem_ocr.sort(key=lambda x: x.get("nome", "").lower())
    mp4s.sort(key=lambda x: x.get("nome", "").lower())
    m4as.sort(key=lambda x: x.get("nome", "").lower())

    return jpgs + pngs + pdfs_sem_ocr + mp4s + m4as


def criar_bloco_midia_drive(arquivo: dict) -> dict:
    """Cria o bloco Notion correto para arquivos do Google Drive."""
    nome = arquivo.get("nome", "")
    mime = arquivo.get("mimeType", "").lower()
    id_drive = arquivo.get("id", "")
    if not id_drive:
        return None

    ext = Path(nome).suffix.lower()
    url_sharing = f"https://drive.google.com/file/d/{id_drive}/view?usp=sharing"
    url_drive_link = f"https://drive.google.com/file/d/{id_drive}/view?usp=drive_link"

    # 1. Vídeo (MP4, WEBM) -> bloco video external
    if "video" in mime or ext in (".mp4", ".mkv", ".webm", ".mov"):
        return {
            "type": "video",
            "video": {
                "type": "external",
                "external": {"url": url_drive_link}
            }
        }

    # 2. Imagens (JPG, PNG) -> bloco embed sharing
    if "image" in mime or ext in (".jpg", ".jpeg", ".png", ".webp", ".gif", ".svg"):
        return {
            "type": "embed",
            "embed": {"url": url_sharing}
        }

    # 3. PDF Sem OCR -> bloco embed sharing
    if "pdf" in mime or ext == ".pdf":
        return {
            "type": "embed",
            "embed": {"url": url_sharing}
        }

    # 4. Áudio (M4A, MP3) -> bloco embed drive_link
    if "audio" in mime or ext in (".m4a", ".mp3", ".wav", ".ogg", ".aac"):
        return {
            "type": "embed",
            "embed": {"url": url_drive_link}
        }

    return None


# ==============================================================================
# 🔍 LEITURA DO DB.JSON LOCAL
# ==============================================================================
def carregar_db_local() -> dict:
    """Carrega o db.json do Study OS."""
    if not DB_JSON_PATH.exists():
        print(f"⚠️ db.json não encontrado em {DB_JSON_PATH}")
        return None
    try:
        with open(DB_JSON_PATH, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception as e:
        print(f"⚠️ Erro ao carregar db.json: {e}")
        return None


def extrair_todas_materias_db(db_root: dict) -> list:
    """Coleta todas as pastas de disciplinas no db.json com seus caminhos completos."""
    materias = []

    def varrer(node, caminho_pai=""):
        nome = node.get("nome", "")
        tipo = node.get("tipo", "")
        caminho_atual = f"{caminho_pai}/{nome}".strip("/")

        filhos = node.get("filhos", [])
        tem_aulas = any("aula" in str(f.get("nome", "")).lower() for f in filhos if f.get("tipo") == "pasta")

        if tipo == "pasta" and tem_aulas:
            materias.append({
                "node": node,
                "nome": nome,
                "local": node.get("local") or caminho_atual,
                "cover": node.get("cover", ""),
                "prof": node.get("prof", ""),
                "status": node.get("Status") or node.get("status", ""),
                "id_drive": node.get("id", "")
            })
            return

        for f in filhos:
            if f.get("tipo") == "pasta":
                varrer(f, caminho_atual)

    if db_root:
        varrer(db_root)
    return materias


# ==============================================================================
# 🚀 MOTOR 1: VARREDURA NOTION ➔ ESTRUTURAÇÃO /notion NO FIREBASE
# ==============================================================================
def sincronizar_notion_para_firebase(token: str, dry_run: bool = False) -> dict:
    """Varre o Notion e salva organizadamente em /notion no Firebase."""
    print("\n" + "=" * 75)
    print("🔍 FASE 1: VARREDURA NOTION ➔ ESTRUTURAÇÃO /notion NO FIREBASE")
    print("=" * 75)

    print("📡 Consultando matérias no Notion...")
    paginas = notion_buscar_paginas(token=token, filter_obj={"property": "object", "value": "page"})

    cursos_map = {}
    aulas_map = {}
    notas_map = {}

    db_cursos_id_clean = ID_DATABASE_CURSOS.replace("-", "")
    db_aulas_id_clean = ID_DATABASE_CONTROLE_AULAS.replace("-", "")
    db_notas_id_clean = ID_DATABASE_NOTAS.replace("-", "")

    for p in paginas:
        parent = p.get("parent", {})
        parent_db = (parent.get("database_id") or "").replace("-", "")
        p_id = p.get("id")

        if parent_db == db_cursos_id_clean:
            props = p.get("properties", {})
            nome_obj = props.get("Nome", {}).get("title", [])
            nome = nome_obj[0].get("plain_text", "").strip() if nome_obj else "Sem Nome"

            prof_obj = props.get("Prof", {}).get("rich_text", [])
            prof = prof_obj[0].get("plain_text", "").strip() if prof_obj else ""

            status_obj = props.get("Status", {}).get("status", {})
            status = status_obj.get("name", "") if status_obj else ""

            ano_obj = props.get("Ano", {}).get("multi_select", [])
            ano_tags = [opt.get("name", "") for opt in ano_obj]

            nota_final_obj = props.get("Nota final", {}).get("rollup", {})
            nota_final = nota_final_obj.get("number", 0)

            rel_aulas = props.get(" Controle de Aulas", {}).get("relation", [])
            aulas_ids = [rel.get("id") for rel in rel_aulas]

            rel_notas = props.get("Notas", {}).get("relation", [])
            notas_ids = [rel.get("id") for rel in rel_notas]

            cover = p.get("cover")
            cover_url = cover.get("external", {}).get("url") if cover and cover.get("type") == "external" else ""
            icon = p.get("icon")
            icon_emoji = icon.get("emoji") if icon and icon.get("type") == "emoji" else ""

            cursos_map[p_id] = {
                "id": p_id,
                "nome": nome,
                "prof": prof,
                "status": status,
                "cover_url": cover_url,
                "icon_emoji": icon_emoji,
                "ano_tags": ano_tags,
                "nota_final": nota_final,
                "aulas_ids": aulas_ids,
                "notas_ids": notas_ids,
                "url": p.get("url", "")
            }

        elif parent_db == db_aulas_id_clean:
            props = p.get("properties", {})
            titulo_obj = props.get("Capítulo e Matéria", {}).get("title", [])
            titulo = titulo_obj[0].get("plain_text", "").strip() if titulo_obj else "Aula"

            rel_cursos = props.get("📒Cursos", {}).get("relation", [])
            curso_id = rel_cursos[0].get("id") if rel_cursos else ""

            data_obj = props.get("Date", {}).get("date", {})
            data_str = data_obj.get("start", "") if data_obj else ""

            presenca = props.get("Presença", {}).get("checkbox", False)
            revisao = props.get("Revisão de aula", {}).get("checkbox", False)

            atraso_obj = props.get("Atraso", {}).get("formula", {})
            atraso = atraso_obj.get("string", "") if atraso_obj else ""

            falta_obj = props.get("Falta", {}).get("formula", {})
            falta = falta_obj.get("string", "") if falta_obj else ""

            aulas_map[p_id] = {
                "id": p_id,
                "titulo": titulo,
                "numero_aula": extrair_numero_aula(titulo),
                "curso_id": curso_id,
                "data": data_str,
                "presenca": presenca,
                "revisao": revisao,
                "atraso": atraso,
                "falta": falta,
                "url": p.get("url", "")
            }

        elif parent_db == db_notas_id_clean:
            props = p.get("properties", {})
            nome_obj = props.get("Name", {}).get("title", [])
            nome = nome_obj[0].get("plain_text", "").strip() if nome_obj else "Atividade"

            rel_materia = props.get("Materia", {}).get("relation", [])
            curso_id = rel_materia[0].get("id") if rel_materia else ""

            status_obj = props.get("Status", {}).get("status", {})
            status = status_obj.get("name", "") if status_obj else ""

            tipo_obj = props.get("Tipo", {}).get("select", {})
            tipo = tipo_obj.get("name", "") if tipo_obj else ""

            aval_obj = props.get("A", {}).get("select", {})
            avaliacao = aval_obj.get("name", "") if aval_obj else ""

            nota_obtida = props.get("Nota obtida", {}).get("number", 0)
            nota_maxima = props.get("Nota maxima", {}).get("number", 0)

            data_obj = props.get("Data", {}).get("date", {})
            data_str = data_obj.get("start", "") if data_obj else ""

            notas_map[p_id] = {
                "id": p_id,
                "nome": nome,
                "curso_id": curso_id,
                "status": status,
                "tipo": tipo,
                "avaliacao": avaliacao,
                "nota_obtida": nota_obtida,
                "nota_maxima": nota_maxima,
                "data": data_str,
                "url": p.get("url", "")
            }

    print(f"   📊 Matérias em Cursos:         {len(cursos_map)}")
    print(f"   📅 Aulas em Controle de Aulas: {len(aulas_map)}")
    print(f"   📝 Atividades em Notas:        {len(notas_map)}")

    relatorio = {
        "cursos": cursos_map,
        "controle_de_aulas": aulas_map,
        "atividades_notas": notas_map,
        "ultima_atualizacao": time.strftime("%Y-%m-%d %H:%M:%S")
    }

    if not dry_run:
        print("\n☁️ Enviando dados estruturados para o Firebase (/notion)...")
        firebase_put("notion/cursos", cursos_map)
        firebase_put("notion/controle_de_aulas", aulas_map)
        firebase_put("notion/atividades_notas", notas_map)
        firebase_put("notion/ultima_atualizacao", relatorio["ultima_atualizacao"])
        print("   ✅ Firebase atualizado com sucesso em /notion!")
    else:
        print("\n🔍 MODO DRY-RUN: Simulação concluída sem alterações no Firebase.")

    return relatorio


# ==============================================================================
# 🔄 MOTOR 2: ENRIQUECIMENTO BIDIRECIONAL (BANNERS, PROFESSORES, STATUS)
# ==============================================================================
def enriquecer_metadados_bidirecional(token: str, dry_run: bool = False):
    """Sincroniza capas, professores, status e emojis entre Notion e db.json."""
    print("\n" + "=" * 75)
    print("🔄 FASE 2: ENRIQUECIMENTO INTELIGENTE BIDIRECIONAL (BANNERS / PROF / STATUS)")
    print("=" * 75)

    db_local = carregar_db_local()
    if not db_local:
        print("❌ Não foi possível carregar o db.json local.")
        return

    materias_db = extrair_todas_materias_db(db_local)
    print(f"📂 Matérias encontradas no db.json local: {len(materias_db)}")

    relatorio_notion = sincronizar_notion_para_firebase(token=token, dry_run=True)
    cursos_notion = relatorio_notion.get("cursos", {})

    aulas_notion = relatorio_notion.get("controle_de_aulas", {})
    notas_notion = relatorio_notion.get("atividades_notas", {})

    db_modificado = False
    alteracoes_notion = 0
    alteracoes_db = 0
    total_atividades_vinculadas = 0
    total_aulas_vinculadas = 0

    for curso_id, curso in cursos_notion.items():
        materia_db = casar_materia_notion_com_db(curso, materias_db)
        if not materia_db:
            continue

        node_db = materia_db["node"]
        nome_db = materia_db["nome"]

        # 1. Cover / Banner
        cover_notion = curso.get("cover_url", "").strip()
        cover_db = node_db.get("cover", "").strip()

        if cover_notion and (not cover_db or "unsplash" not in cover_db):
            print(f"   🖼️ [Notion ➔ db.json] Capa para '{nome_db}'")
            node_db["cover"] = cover_notion
            db_modificado = True
            alteracoes_db += 1
        elif cover_db and not cover_notion:
            print(f"   🖼️ [db.json ➔ Notion] Injetando Capa em '{curso['nome']}'...")
            if not dry_run:
                try:
                    notion_atualizar_pagina(curso_id, cover_url=cover_db, token=token)
                    alteracoes_notion += 1
                except Exception as e:
                    print(f"      ⚠️ Falha ao atualizar capa no Notion: {e}")

        # 2. Professor(a)
        prof_notion = curso.get("prof", "").strip()
        prof_db = str(node_db.get("prof", "")).strip()

        placeholder_prof = ("por favor digite" in prof_db.lower() or not prof_db)
        if prof_notion and placeholder_prof:
            print(f"   👤 [Notion ➔ db.json] Professor para '{nome_db}': {prof_notion}")
            node_db["prof"] = prof_notion
            db_modificado = True
            alteracoes_db += 1
        elif prof_db and not placeholder_prof and not prof_notion:
            print(f"   👤 [db.json ➔ Notion] Professor para '{curso['nome']}': {prof_db}")
            if not dry_run:
                try:
                    prop_prof = {"Prof": {"rich_text": [{"type": "text", "text": {"content": prof_db}}]}}
                    notion_atualizar_pagina(curso_id, propriedades=prop_prof, token=token)
                    alteracoes_notion += 1
                except Exception as e:
                    print(f"      ⚠️ Falha ao atualizar prof no Notion: {e}")

        # 3. Status
        status_notion = curso.get("status", "").strip()
        if status_notion:
            node_db["Status"] = status_notion
            node_db["status"] = status_notion.lower()
            db_modificado = True

        # 4. Tags & Horário (Ano / Semestre)
        tags_notion = curso.get("ano_tags", [])
        if tags_notion:
            node_db["tags"] = tags_notion
            db_modificado = True

        # 5. Emoji
        emoji_notion = curso.get("icon_emoji", "").strip()
        emoji_db, _ = extrair_icone_e_nome(nome_db)
        if not emoji_notion and emoji_db and emoji_db != "📘":
            if not dry_run:
                try:
                    notion_atualizar_pagina(curso_id, icon_emoji=emoji_db, token=token)
                    alteracoes_notion += 1
                except Exception as e:
                    print(f"      ⚠️ Falha ao colocar emoji no Notion: {e}")

        # 6. Atividades Valendo Nota (Banco Notas ➔ db.json)
        atividades_da_materia = []
        for nid, ativ in notas_notion.items():
            if ativ.get("curso_id") == curso_id:
                atividades_da_materia.append({
                    "nome": ativ.get("nome", "Atividade"),
                    "status": ativ.get("status", "A fazer"),
                    "tipo": ativ.get("tipo", ""),
                    "avaliacao": ativ.get("avaliacao", ""),
                    "nota_obtida": ativ.get("nota_obtida", 0),
                    "nota_maxima": ativ.get("nota_maxima", 0),
                    "data": ativ.get("data", "")
                })

        if atividades_da_materia:
            atividades_da_materia.sort(key=lambda x: (x.get("avaliacao", ""), x.get("data", "")))
            node_db["atividades"] = atividades_da_materia
            total_atividades_vinculadas += len(atividades_da_materia)
            db_modificado = True

        # 7. Datas e Presenças das Aulas (Controle de Aulas ➔ db.json)
        for aid, aula in aulas_notion.items():
            if aula.get("curso_id") == curso_id:
                num_aula = aula.get("numero_aula")
                for f in node_db.get("filhos", []):
                    if f.get("tipo") == "pasta" and extrair_numero_aula(f.get("nome")) == num_aula:
                        if aula.get("data"):
                            f["data_aula"] = aula.get("data")
                            db_modificado = True
                        if "presenca" in aula:
                            f["presenca"] = aula.get("presenca")
                            db_modificado = True
                        if "revisao" in aula:
                            f["revisao"] = aula.get("revisao")
                            db_modificado = True
                        total_aulas_vinculadas += 1
                        break

    print(f"\n📊 Resumo da Mesclagem:")
    print(f"   ✅ Atividades vinculadas às matérias: {total_atividades_vinculadas}")
    print(f"   ✅ Aulas com data/presença vinculadas: {total_aulas_vinculadas}")

    if db_modificado and not dry_run:
        print("\n💾 Salvando alterações no db.json local...")
        try:
            with open(DB_JSON_PATH, "w", encoding="utf-8") as f:
                json.dump(db_local, f, ensure_ascii=False, indent=2)
            print("   ✅ db.json local atualizado com sucesso!")
        except Exception as e:
            print(f"   ⚠️ Erro ao gravar db.json local: {e}")

        print("☁️ Enviando db.json atualizado para o Firebase (/db_json)...")
        fb_ok = firebase_put("db_json", db_local)
        if fb_ok:
            print("   ✅ Firebase (/db_json) atualizado com sucesso!")
        else:
            print("   ⚠️ Falha ao atualizar nó /db_json no Firebase.")

    print(f"\n🎉 Enriquecimento concluído: {alteracoes_db} campos atualizados no db.json | {alteracoes_notion} no Notion.")


# ==============================================================================
# 🎬 MOTOR 3: PILOTO AUTOMÁTICO AULA POR AULA (COM CRIAÇÃO INTELIGENTE NO CONTROLE DE AULAS)
# ==============================================================================
def obter_ou_criar_synced_block_original(pagina_curso_id: str, num_aula: int, token: str) -> str:
    """
    Localiza o toggle H2 'Aula X' dentro da matéria no Notion e obtém o Synced Block original.
    Se o toggle ou o Synced Block não existirem, cria com perfeição!
    """
    blocos_pagina = notion_listar_filhos(pagina_curso_id, token=token)

    bloco_toggle = None
    for b in blocos_pagina:
        if b.get("type") == "heading_2":
            h2_obj = b.get("heading_2", {})
            rich_txt = h2_obj.get("rich_text", [])
            txt = rich_txt[0].get("plain_text", "") if rich_txt else ""
            if extrair_numero_aula(txt) == num_aula:
                bloco_toggle = b
                break

    # Se não tiver o toggle H2, cria
    if not bloco_toggle:
        titulo_toggle = f"Aula {num_aula}" if num_aula != 999 else "Aula de Conclusão"
        print(f"      ➕ Criando toggle H2 '{titulo_toggle}' na matéria do Notion...")
        novo_h2 = {
            "type": "heading_2",
            "heading_2": {
                "rich_text": [{"type": "text", "text": {"content": titulo_toggle}}],
                "is_toggleable": True
            }
        }
        resp = notion_anexar_blocos(pagina_curso_id, [novo_h2], token=token)
        resultados = resp.get("results", [])
        if resultados:
            bloco_toggle = resultados[0]
        else:
            return None

    toggle_id = bloco_toggle["id"]
    filhos_toggle = notion_listar_filhos(toggle_id, token=token)

    for fb in filhos_toggle:
        if fb.get("type") == "synced_block":
            synced_from = fb.get("synced_block", {}).get("synced_from")
            # Se já for um espelho de outro bloco, retorna o ID do bloco raiz original
            if synced_from and synced_from.get("block_id"):
                return synced_from["block_id"]
            return fb["id"]

    # Cria o Synced Block original se não houver
    print(f"      🔗 Criando Synced Block original dentro do toggle...")
    novo_synced = {
        "type": "synced_block",
        "synced_block": {"synced_from": None}
    }
    resp_synced = notion_anexar_blocos(toggle_id, [novo_synced], token=token)
    res_synced = resp_synced.get("results", [])
    if res_synced:
        return res_synced[0]["id"]

    return None


def garantir_aula_no_controle_de_aulas(curso_id: str, nome_materia: str, num_aula: int, original_synced_id: str, aulas_existentes_map: dict, token: str) -> str:
    """
    Verifica se a aula existe no banco Controle de Aulas.
    Se NÃO existir:
      1. Cria a página com emoji correto, título padrão e relação com o curso (data vazia).
      2. Injeta o Synced Block espelhado referenciando o bloco original da matéria.
    """
    # 1. Procura se já existe página no Controle de Aulas para esse curso_id e num_aula
    for aula_id, aula_dados in aulas_existentes_map.items():
        if aula_dados.get("curso_id") == curso_id and aula_dados.get("numero_aula") == num_aula:
            print(f"      ✅ Aula já existe no Controle de Aulas: '{aula_dados['titulo']}'")
            # Auto-vínculo inteligente: verifica se o espelho do Synced Block está conectado
            if original_synced_id:
                filhos_aula = notion_listar_filhos(aula_id, token=token)
                tem_espelho = any(
                    fb.get("type") == "synced_block" and (
                        fb["id"] == original_synced_id or 
                        (fb.get("synced_block", {}).get("synced_from") or {}).get("block_id") == original_synced_id
                    )
                    for fb in filhos_aula
                )
                if not tem_espelho:
                    print(f"      🔗 [Auto-Vínculo] Espelho do Synced Block ausente ou desvinculado. Conectando agora...")
                    # Limpa blocos synced vazios e desvinculados que possam ter ficado órfãos
                    for fb in filhos_aula:
                        if fb.get("type") == "synced_block" and not fb.get("synced_block", {}).get("synced_from"):
                            sub_filhos = notion_listar_filhos(fb["id"], token=token)
                            if not sub_filhos:
                                try:
                                    notion_deletar_bloco(fb["id"], token=token)
                                except Exception:
                                    pass
                    # Injeta o Synced Block espelhado
                    bloco_espelhado = {
                        "type": "synced_block",
                        "synced_block": {
                            "synced_from": {
                                "type": "block_id",
                                "block_id": original_synced_id
                            }
                        }
                    }
                    notion_anexar_blocos(aula_id, [bloco_espelhado], token=token)
                    print(f"      ✅ Espelho vinculado com sucesso no Controle de Aulas!")
            return aula_id

    # 2. Se não existir, cria a página no banco Controle de Aulas!
    titulo_aula = formatar_titulo_controle_aula(nome_materia, num_aula)
    emoji_materia, _ = extrair_icone_e_nome(nome_materia)

    print(f"      ⚠️ Matéria está sem a Aula no Controle de Aulas! Criando '{titulo_aula}' ({emoji_materia})...")

    propriedades = {
        "Capítulo e Matéria": {
            "title": [{"type": "text", "text": {"content": titulo_aula}}]
        },
        "📒Cursos": {
            "relation": [{"id": curso_id}]
        },
        "Presença": {
            "checkbox": False
        },
        "Revisão de aula": {
            "checkbox": False
        }
    }

    nova_pagina = notion_criar_pagina(ID_DATABASE_CONTROLE_AULAS, propriedades, icon_emoji=emoji_materia, token=token)
    nova_aula_id = nova_pagina.get("id")

    if nova_aula_id and original_synced_id:
        # Injeta o Duplicate Synced Block espelhado
        print(f"      🔗 Vinculando Synced Block duplicado na página da aula...")
        bloco_espelhado = {
            "type": "synced_block",
            "synced_block": {
                "synced_from": {
                    "type": "block_id",
                    "block_id": original_synced_id
                }
            }
        }
        notion_anexar_blocos(nova_aula_id, [bloco_espelhado], token=token)

    return nova_aula_id


def sincronizar_aulas_automatico(token: str, filtro_materia: str = None, dry_run: bool = False):
    """
    PILOTO AUTOMÁTICO AULA POR AULA:
    Varre cada matéria, garante a página no Controle de Aulas, sincroniza os blocos
    e injeta o conteúdo (Markdown) e mídias do Drive no lugar certo.
    """
    print("\n" + "=" * 75)
    print("🎬 FASE 3: PILOTO AUTOMÁTICO AULA POR AULA (CONTROLE DE AULAS + MÍDIAS DRIVE)")
    print("=" * 75)

    db_local = carregar_db_local()
    if not db_local:
        print("❌ Não foi possível carregar o db.json local.")
        return

    materias_db = extrair_todas_materias_db(db_local)
    relatorio = sincronizar_notion_para_firebase(token=token, dry_run=True)
    cursos_notion = relatorio.get("cursos", {})
    aulas_notion = relatorio.get("controle_de_aulas", {})

    total_aulas_processadas = 0

    for curso_id, curso in cursos_notion.items():
        nome_curso = curso["nome"]

        if filtro_materia:
            if normalizar_texto(filtro_materia) not in normalizar_texto(nome_curso):
                continue

        materia_db = casar_materia_notion_com_db(curso, materias_db)
        if not materia_db:
            print(f"⚠️ Matéria '{nome_curso}' não encontrada no db.json local.")
            continue

        print(f"\n📚 Disciplina: '{nome_curso}' ⟷ Pasta local: '{materia_db['nome']}'")
        pastas_filhas = materia_db["node"].get("filhos", [])

        pastas_aula = [
            f for f in pastas_filhas
            if f.get("tipo") == "pasta" and extrair_numero_aula(f.get("nome", "")) is not None
        ]
        pastas_aula.sort(key=lambda x: extrair_numero_aula(x.get("nome", "")) or 0)

        for pasta in pastas_aula:
            nome_pasta_aula = pasta.get("nome", "")
            num_aula = extrair_numero_aula(nome_pasta_aula)
            titulo_bonito = f"Aula {num_aula}" if num_aula != 999 else "Aula de Conclusão"
            print(f"\n   ▶️ Processando {titulo_bonito} ({nome_pasta_aula})...")

            if dry_run:
                print(f"      🔍 [Dry-Run] Detectada pasta com {len(pasta.get('filhos', []))} arquivos. Simulação OK.")
                total_aulas_processadas += 1
                continue

            # 1. Localiza ou cria o Synced Block original na página do Curso (H2)
            original_synced_id = obter_ou_criar_synced_block_original(curso_id, num_aula, token=token)
            if not original_synced_id:
                print(f"      ⚠️ Falha ao obter Synced Block original para {titulo_bonito}.")
                continue

            # 2. Garante que a aula exista no banco Controle de Aulas e vincula o espelho
            garantir_aula_no_controle_de_aulas(
                curso_id=curso_id,
                nome_materia=materia_db["nome"],
                num_aula=num_aula,
                original_synced_id=original_synced_id,
                aulas_existentes_map=aulas_notion,
                token=token
            )

            # 3. Verifica se o Synced Block original já tem conteúdo real
            filhos_atuais = notion_listar_filhos(original_synced_id, token=token)

            # Detecta se há blocos com formatação Markdown corrompida (ex: \#, \##, \###, \* ou \  escapados indevidamente no Notion)
            conteudo_corrompido = False
            for fb in filhos_atuais:
                t = fb.get("type", "")
                # Blocos de código legítimos nunca devem ser considerados corrompidos por conterem barras invertidas (ex: \n)
                if t == "code":
                    continue
                rt = fb.get(t, {}).get("rich_text", [])
                txt = "".join(x.get("plain_text", "") for x in rt).strip()
                if (txt.startswith(r"\#") or txt.startswith(r"\*") or txt.startswith(r"\-") or 
                    txt.startswith(r"\ ") or r"\###" in txt or r"\##" in txt or 
                    (t == "paragraph" and txt.startswith("```"))):
                    conteudo_corrompido = True
                    break

            if conteudo_corrompido:
                print(f"      ⚠️ Detectado conteúdo com formatação corrompida (\\#, \\###) no Synced Block.")
                print(f"      🧹 Limpando {len(filhos_atuais)} blocos corrompidos para reinjeção com formatação perfeita...")
                for fb in filhos_atuais:
                    try:
                        notion_deletar_bloco(fb["id"], token=token)
                    except Exception:
                        pass
                filhos_atuais = []
            elif len(filhos_atuais) > 2 or (len(filhos_atuais) == 1 and filhos_atuais[0].get("type") != "paragraph"):
                # Detecta se faltam mídias do Google Drive no final do Synced Block
                arquivos_midia = [
                    item for item in pasta.get("filhos", [])
                    if item.get("tipo") == "arquivo" and not item.get("nome", "").lower().endswith(".md")
                ]
                midias_esperadas = classificar_midias_drive(arquivos_midia)

                if midias_esperadas:
                    urls_existentes = set()
                    for fb in filhos_atuais:
                        t = fb.get("type", "")
                        if t == "embed":
                            u = fb.get("embed", {}).get("url", "")
                            if u:
                                urls_existentes.add(u)
                        elif t == "video":
                            u = fb.get("video", {}).get("external", {}).get("url", "")
                            if u:
                                urls_existentes.add(u)

                    midias_faltantes = [
                        arq for arq in midias_esperadas
                        if arq.get("id") and not any(arq["id"] in u for u in urls_existentes)
                    ]

                    if midias_faltantes:
                        print(f"      🎬 [Auto-Completar] Texto seguro preservado ({len(filhos_atuais)} blocos). Faltam {len(midias_faltantes)} mídias do Drive!")
                        blocos_midia = []
                        for arq in midias_faltantes:
                            b = criar_bloco_midia_drive(arq)
                            if b:
                                blocos_midia.append(b)
                        if blocos_midia:
                            blocos_midia.append({"type": "paragraph", "paragraph": {"rich_text": []}})
                            notion_anexar_blocos(original_synced_id, blocos_midia, token=token)
                            print(f"      ✅ {len(midias_faltantes)} mídias do Drive anexadas com sucesso!")
                            total_aulas_processadas += 1
                            continue

                print(f"      ✨ Synced Block 100% completo ({len(filhos_atuais)} blocos com texto e mídias). Conteúdo seguro preservado.")
                continue
            elif len(filhos_atuais) == 1 and filhos_atuais[0].get("type") == "paragraph":
                # Remove parágrafo vazio residual que o Notion cria por padrão dentro de synced blocks novos
                try:
                    notion_deletar_bloco(filhos_atuais[0]["id"], token=token)
                except Exception:
                    pass

            # 4. Injeta o Markdown + Mídias do Drive dentro do Synced Block original
            sucesso = replicar_arquivos_no_synced_block(original_synced_id, pasta, token=token)
            if sucesso:
                total_aulas_processadas += 1

    print(f"\n🎉 Processamento concluído! Total de aulas sincronizadas: {total_aulas_processadas}")


def replicar_arquivos_no_synced_block(synced_block_id: str, pasta_aula_node: dict, token: str) -> bool:
    """Prepara e anexa o Markdown e as mídias da pasta dentro do Synced Block na ordem rigorosa."""
    filhos = pasta_aula_node.get("filhos", [])
    arquivo_md = None
    arquivos_midia = []

    for item in filhos:
        if item.get("tipo") != "arquivo":
            continue
        nome = item.get("nome", "")
        if nome.lower().endswith(".md") and item.get("conteudoTexto"):
            arquivo_md = item
        else:
            arquivos_midia.append(item)

    blocos_para_inserir = []

    # 1. Markdown estruturado e higienizado (sem escapes \#, \###)
    if arquivo_md:
        nome_md = arquivo_md.get('nome', '')
        print(f"      📄 Inserindo Markdown: {nome_md}")
        avisos_md = auditar_markdown(arquivo_md.get("conteudoTexto", ""), nome_md)
        for av in avisos_md:
            print(f"         ⚠️ [Auditoria MD] {av}")
        blocos_md = markdown_para_blocos_notion(arquivo_md.get("conteudoTexto", ""))
        blocos_para_inserir.extend(blocos_md)

    # 2. Mídias do Drive na ordem rigorosa (JPG -> PNG -> PDF Sem OCR -> MP4 -> M4A)
    midias_ordenadas = classificar_midias_drive(arquivos_midia)
    print(f"      🎬 Inserindo {len(midias_ordenadas)} mídias do Google Drive (ordem: JPG -> PNG -> PDF Sem OCR -> MP4 -> M4A)...")
    for arq in midias_ordenadas:
        bloco = criar_bloco_midia_drive(arq)
        if bloco:
            blocos_para_inserir.append(bloco)

    # Espaçador final
    blocos_para_inserir.append({"type": "paragraph", "paragraph": {"rich_text": []}})

    try:
        notion_anexar_blocos(synced_block_id, blocos_para_inserir, token=token)
        print(f"      ✅ Conteúdo e Mídias injetados com sucesso ({len(blocos_para_inserir)} blocos)!")
        return True
    except Exception as e:
        print(f"      ❌ Erro ao anexar blocos: {e}")
        return False


# ==============================================================================
# 💻 MENU E EXECUÇÃO VIA TERMINAL
# ==============================================================================
def menu_principal():
    print("""
======================================================================
🎓 STUDY OS ➔ SINCRONIZADOR INTELIGENTE DO NOTION
======================================================================
1. 🔍 [Fase 1] Escanear Notion e Atualizar Firebase (/notion)
2. 🔄 [Fase 2] Sincronização Bidirecional (Banners, Professores, Status)
3. 🎬 [Fase 3] Piloto Automático: Sincronizar Aulas no Notion (Aula por Aula)
4. 🧪 [Dry-Run] Simular Todas as Ações sem Modificar Nada
5. ⚙️ Configurar / Atualizar Token do Notion
6. 🚀 Sair
======================================================================
""")
    escolha = input("Selecione uma opção (1-6): ").strip()
    return escolha


def main():
    token = obter_notion_token()
    if not token:
        print("\n⚠️ Nenhum token do Notion foi encontrado.")
        print("Cole sua chave de integração interna do Notion (secret_... ou ntn_...).")
        novo_token = input("Cole seu Token do Notion aqui: ").strip()
        if novo_token:
            salvar_notion_config(novo_token)
            token = novo_token
        else:
            print("❌ Operação cancelada. Nenhum token informado.")
            return

    # Argumentos CLI diretos
    if "--dry-run" in sys.argv:
        enriquecer_metadados_bidirecional(token=token, dry_run=True)
        return

    if "--scan" in sys.argv:
        sincronizar_notion_para_firebase(token=token, dry_run=False)
        return

    if "--sync-meta" in sys.argv:
        enriquecer_metadados_bidirecional(token=token, dry_run=False)
        return

    if "--sync-aulas" in sys.argv:
        sincronizar_aulas_automatico(token=token, dry_run=False)
        return

    # Modo Interativo
    while True:
        opcao = menu_principal()
        if opcao == "1":
            sincronizar_notion_para_firebase(token=token, dry_run=False)
        elif opcao == "2":
            enriquecer_metadados_bidirecional(token=token, dry_run=False)
        elif opcao == "3":
            print("\nPiloto Automático de Aulas:")
            print("[1] Sincronizar TODAS as matérias")
            print("[2] Sincronizar apenas uma matéria específica")
            sub_op = input("Escolha (1 ou 2): ").strip()
            if sub_op == "2":
                nome_mat = input("Digite o nome da matéria (ex: Big Data): ").strip()
                sincronizar_aulas_automatico(token=token, filtro_materia=nome_mat, dry_run=False)
            else:
                sincronizar_aulas_automatico(token=token, dry_run=False)
        elif opcao == "4":
            enriquecer_metadados_bidirecional(token=token, dry_run=True)
        elif opcao == "5":
            novo = input("Digite o novo Token do Notion: ").strip()
            if novo:
                salvar_notion_config(novo)
                token = novo
        elif opcao == "6":
            print("👋 Encerrando. Até mais!")
            break
        else:
            print("Opção inválida. Tente novamente.")


if __name__ == "__main__":
    main()
