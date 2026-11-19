#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
================================================================================
⚡ STUDY OS — STUDIO WORKER LOCAL (studio_worker.py)
================================================================================
Serviço local isolado (Porta 8090) para automação de geração de artefatos no
Google NotebookLM via `notebooklm-py` (https://github.com/teng-lin/notebooklm-py)
e gerenciamento do Painel de Revisão (Staging Diff A/B).

REGRAS DE OURO IMPLEMENTADAS:
1. Isolamento Total: NÃO altera nem depende da execução do script legado
   `Sincronizador da Fila (Rode no PC).py`.
2. Zero Consulta de Artefatos na Leitura: O estado dos artefatos vem do `db.json`.
   O `notebooklm-py` é acionado EXCLUSIVAMENTE para:
   - Listar/editar fontes do caderno sob demanda (`GET /api/studio/fontes`)
   - Gerar e baixar os 8 tipos de artefatos da aula.
3. Clique Frenético (Fire-and-Forget): `POST /api/studio/enfileirar` registra
   1 item, 1 aula inteira (`all`) ou lote de matéria (`batch_materia`) em < 20ms.
4. Guardião de Cota Persistente: Erros de cota/rate-limit pausam os jobs com
   status `aguardando_cota` sem descartá-los, retomando automaticamente depois.
5. Auto-Aprovação de Não-Visuais: `flashcards.md`, `quiz.md`, `mapa-mental.json`
   e `relatorio.md` vão direto para a pasta oficial da aula e atualizam o
   `db.json` sem exigir aprovação humana. Já os artefatos visuais/mídia
   (`infografico` .png, `slides` .pdf, `video` .mp4, `audio` .m4a) vão para
   `staging/` com status `revisao` para aprovação Lado a Lado (Diff A/B).
================================================================================
"""

import os
import re
import ast
import sys
import json
import time
import uuid
import shutil
import socket
import asyncio
import mimetypes
import subprocess
import threading
import traceback
import urllib.parse
import urllib.request
import urllib.error
from pathlib import Path
from typing import Any, Dict, List, Optional, Set, Tuple

# Garante suporte a UTF-8 no terminal Windows
if sys.platform == "win32":
    try:
        sys.stdout.reconfigure(encoding="utf-8")
        sys.stderr.reconfigure(encoding="utf-8")
    except Exception:
        pass

# ==============================================================================
# ⚙️ CONFIGURAÇÕES DE DIRETÓRIOS, PORTA E FIREBASE
# ==============================================================================
SCRIPT_DIR = Path(__file__).resolve().parent
PORTA_WORKER = int(os.environ.get("STUDIO_WORKER_PORT", "8090"))
HOST_WORKER = os.environ.get("STUDIO_WORKER_HOST", "127.0.0.1")

def _resolver_staging_local_dir() -> Path:
    """Resolve diretório local gravável para staging evitando locks do DriveFS."""
    import tempfile
    candidatos: List[Path] = []
    env_dir = os.environ.get("STUDIO_STAGING_DIR", "").strip()
    if env_dir:
        candidatos.append(Path(env_dir))
    candidatos.extend([
        SCRIPT_DIR / "staging",
        Path(os.environ.get("LOCALAPPDATA") or tempfile.gettempdir()) / "StudyOS" / "staging",
        Path(tempfile.gettempdir()) / "study_os_staging",
    ])
    for cand in candidatos:
        try:
            cand.mkdir(parents=True, exist_ok=True)
            list(cand.iterdir())
            probe = cand / ".write_probe"
            probe.write_text("ok", encoding="utf-8")
            probe.unlink()
            return cand
        except OSError:
            continue
    return Path(tempfile.gettempdir()) / "study_os_staging"


def _resolver_fila_studio_path() -> Path:
    """
    Armazena a fila persistente em %LOCALAPPDATA%\\StudyOS\\fila_studio.json para
    evitar recarregamentos (F5) do VS Code Live Server na pasta do projeto.
    Migra automaticamente eventual fila_studio.json legado da pasta do script.
    """
    import tempfile
    env_fila = os.environ.get("STUDIO_FILA_PATH", "").strip()
    if env_fila:
        destino = Path(env_fila)
        destino.parent.mkdir(parents=True, exist_ok=True)
        return destino

    destino = Path(os.environ.get("LOCALAPPDATA") or tempfile.gettempdir()) / "StudyOS" / "fila_studio.json"
    destino.parent.mkdir(parents=True, exist_ok=True)
    legado = SCRIPT_DIR / "fila_studio.json"
    if legado.exists() and not destino.exists():
        try:
            shutil.copy2(legado, destino)
            legado.unlink()
        except OSError:
            pass
    elif legado.exists():
        try:
            legado.unlink()
        except OSError:
            pass
    return destino


STUDIO_ADMIN_GATE = "studyos_admin_v1"
FILA_STUDIO_PATH = _resolver_fila_studio_path()
STAGING_DIR = _resolver_staging_local_dir()
PROMPTS_JSON_PATH = SCRIPT_DIR / "prompts.json"
DB_JSON_PATH = SCRIPT_DIR / "db.json"
DB_PERSONAL_PATH = SCRIPT_DIR / "db.personal.json"

# Diretório raiz das pastas de matérias/aulas no Google Drive Desktop
BASE_DRIVE_DIR = Path(os.environ.get("STUDYOS_DRIVE_DIR", r"G:\Meu Drive\CienciaComputacao"))
DRIVE_STAGING_DIR = (BASE_DRIVE_DIR / "_staging_studio") if BASE_DRIVE_DIR.exists() else STAGING_DIR

FIREBASE_URL = "https://study-os-beta-default-rtdb.firebaseio.com"
FIREBASE_SECRET = os.environ.get("FIREBASE_SECRET", "")
if not FIREBASE_SECRET:
    try:
        cfg_path = SCRIPT_DIR / "notion_config.json"
        if cfg_path.exists():
            cfg_data = json.loads(cfg_path.read_text(encoding="utf-8"))
            FIREBASE_SECRET = cfg_data.get("firebase_secret", "")
    except Exception:
        pass

# Intervalo (segundos) para o Guardião de Cota tentar retomar jobs `aguardando_cota`
INTERVALO_RETRY_COTA_SEGUNDOS = int(os.environ.get("STUDIO_QUOTA_RETRY_SEC", "300"))
INTERVALO_LOOP_WORKER_SEGUNDOS = 2.0

# Auto-Relogin NotebookLM (evita parada definitiva quando a sessão Google expira)
NOTEBOOKLM_PYTHON_EXE = os.environ.get("STUDIO_NOTEBOOKLM_PYTHON", sys.executable)
AUTO_RELOGIN_HABILITADO = os.environ.get("STUDIO_AUTO_RELOGIN", "1").strip().lower() not in ("0", "false", "no", "off")
AUTO_RELOGIN_TIMEOUT_SEGUNDOS = int(os.environ.get("STUDIO_AUTO_RELOGIN_TIMEOUT_SEC", "330"))
AUTO_RELOGIN_COOLDOWN_SEGUNDOS = float(os.environ.get("STUDIO_AUTO_RELOGIN_COOLDOWN_SEC", "45.0"))
AUTO_RELOGIN_MAX_TENTATIVAS_JANELA = int(os.environ.get("STUDIO_AUTO_RELOGIN_MAX_TENTATIVAS", "3"))
AUTO_RELOGIN_JANELA_SEGUNDOS = float(os.environ.get("STUDIO_AUTO_RELOGIN_JANELA_SEC", "600.0"))

# Concorrência Inteligente: até 10 gerações simultâneas na nuvem do Google
# com disparo escalonado (stagger), Via Rápida prioritária e lock por (caderno + tipo)
MAX_CONCORRENCIA_GERACAO = max(1, int(os.environ.get("STUDIO_MAX_CONCURRENCY", "10")))
INTERVALO_STAGGER_DISPARO_SEGUNDOS = max(0.0, float(os.environ.get("STUDIO_STAGGER_SEC", "3.0")))
PRIORIDADE_VIA_ARTEFATO: Dict[str, int] = {
    "mindmap": 1,
    "flashcards": 2,
    "quiz": 3,
    "relatorio": 4,
    "infografico": 5,
    "slides": 6,
    "audio": 7,
    "video": 8,
}
TIPOS_VIA_RAPIDA = {"mindmap", "flashcards", "quiz", "relatorio", "infografico"}
TIPOS_VIA_PESADA = {"slides", "audio", "video"}

# ==============================================================================
# 🎯 DEFINIÇÃO DOS 8 TIPOS DE ARTEFATOS E REGRA DE AUTO-APROVAÇÃO
# ==============================================================================
# Regra da Fase 3:
# - Não-visuais (flashcards.md, quiz.md, mapa-mental.json, relatorio.md) ->
#   requer_revisao = False (vão direto para a pasta da aula e db.json sem aprovação).
# - Visuais / Multimídia (infografico .png, slides .pdf, video .mp4, audio .m4a) ->
#   requer_revisao = True (vão para staging/ e aguardam decisão no Painel Diff A/B).

TIPOS_ARTEFATOS_CONFIG: Dict[str, Dict[str, Any]] = {
    "audio": {
        "label": "Resumo de Áudio",
        "extensao": ".m4a",
        "nome_padrao": "Resumo em Áudio.m4a",
        "mime_type": "audio/mp4",
        "requer_revisao": True,
        "categoria_midia": "audio"
    },
    "slides": {
        "label": "Apresentação de Slides",
        "extensao": ".pdf",
        "nome_padrao": "Apresentação de Slides.pdf",
        "mime_type": "application/pdf",
        "requer_revisao": True,
        "categoria_midia": "pdf",
        "tem_ocr": False,
        "status_ocr": "sem_ocr"
    },
    "video": {
        "label": "Resumo em Vídeo",
        "extensao": ".mp4",
        "nome_padrao": "Resumo em Vídeo.mp4",
        "mime_type": "video/mp4",
        "requer_revisao": True,
        "categoria_midia": "video"
    },
    "infografico": {
        "label": "Infográfico",
        "extensao": ".png",
        "nome_padrao": "Infográfico Arquitetural.png",
        "mime_type": "image/png",
        "requer_revisao": True,
        "categoria_midia": "img"
    },
    "mindmap": {
        "label": "Mapa Mental",
        "extensao": ".json",
        "nome_padrao": "mapa-mental.json",
        "mime_type": "application/json",
        "requer_revisao": False,
        "artifact_role": "mindmap"
    },
    "relatorio": {
        "label": "Relatório Técnico",
        "extensao": ".md",
        "nome_padrao": "relatorio.md",
        "mime_type": "text/markdown",
        "requer_revisao": False,
        "artifact_role": "relatorio"
    },
    "flashcards": {
        "label": "Cartões Didáticos (Flashcards)",
        "extensao": ".md",
        "nome_padrao": "flashcards.md",
        "mime_type": "text/markdown",
        "requer_revisao": False,
        "artifact_role": "flashcards"
    },
    "quiz": {
        "label": "Teste / Quiz Tático",
        "extensao": ".md",
        "nome_padrao": "quiz.md",
        "mime_type": "text/markdown",
        "requer_revisao": False,
        "artifact_role": "quiz"
    }
}

TODOS_OS_TIPOS = list(TIPOS_ARTEFATOS_CONFIG.keys())
TIPOS_AUTO_APROVACAO = {k for k, v in TIPOS_ARTEFATOS_CONFIG.items() if not v["requer_revisao"]}
TIPOS_COM_REVISAO = {k for k, v in TIPOS_ARTEFATOS_CONFIG.items() if v["requer_revisao"]}

# ==============================================================================
# 🧠 PROMPTS MESTRES (`prompts.json`), ADAPTAÇÃO POR AULA E CONFIGURAÇÃO AVANÇADA
# ==============================================================================
PROMPTS_FIXOS: Dict[str, str] = {
    "audio": """**Task: High-Fidelity Audio Script Generation (Cognitive Mastery Edition)**
**Persona: The "Distinguished Technical Architect"** (Lex Fridman + Robert C. Martin).
**Advanced Constraints & Guidelines:**
1. **ZERO FLUFF:** Start immediately with the core architectural problem of this lesson.
2. **The "Why" before the "How":** Always explain the problem that necessitated the technology before explaining the solution.
3. **Structural Analogies:** Use analogies that are structurally accurate.
4. **Language:** Brazilian Portuguese (PT-BR). Keep standard English terms for technical keywords and explain them clearly.
5. **Protocol (First Principles):** Deconstruct the lesson to its fundamental truths, connect the dots, and synthesize the real-world engineering takeaway.""",

    "infografico": """**High-end 3D Digital Art with a "Dark Mode" Tech Aesthetic ("IBM meets Cyberpunk 2077")**
* **Subject & Composition:** Symmetrical, clean enterprise architecture dashboard representing the core concepts, workflows, and trade-offs of this lesson in Brazilian Portuguese (PT-BR).
* **Background (Crucial):** Strictly Dark Mode. Deep matte charcoal, obsidian black, and dark navy gradients with subtle hexagonal grid patterns. Absolutely NO white backgrounds.
* **Visual Style & Elements:** Esports/HUD overlays (floating data widgets, slim progress bars, sharp laser vector geometry, brushed metal, glowing fiber optics).
* **Color Palette:** Deep blacks accented by Electric Cyan (data), Neon Purple (depth), and Warning Orange (critical highlights).""",

    "slides": """**Task: Cinematic Keynote Deck Generation (Unreal Engine & Gamer Edition)**
* **Visual Philosophy:** Embrace "Cyber-Industrial" aesthetics in Brazilian Portuguese (PT-BR).
* **Metaphor Translation:** Convert abstract concepts into Game Mechanics (Health Bars, XP Progress Bars, Loadout Matrices, Boss Fight = Core Architectural Bottleneck).
* **Narrative Arc:** Hero's Journey: The Threat (Problem) -> The Weapon (Concept) -> The Victory (Real-World Application).
* **Aesthetic Rules (NON-NEGOTIABLE):**
  1. STRICT DARK MODE: Deep Obsidian (#050A14), Charcoal, Matte Black. NO white backgrounds.
  2. High-Fidelity Unreal Engine 5 / Octane Render visuals contrasted with 8-bit Pixel Art icons and Esports Gamer HUD overlays.""",

    "video": """**Task: Video Lesson Script & Storyboard Generation (Cinematic Tech Edition)**
* **Persona:** "Digital Architect & Director" — Modern Tech Lead tone in Brazilian Portuguese (PT-BR), direct, engaging, zero fluff.
* **Visual Style:** "Dark Blue Tech / DevOps Aesthetic" — Deep Navy/Obsidian backgrounds, Neon Cyan/Purple accents, pixel-art icons for simple concepts, isometric 3D blueprints for complex systems, monospace typography.
* **Structure:** 1. The Hook (Pain Point) -> 2. The Foundation (Core Concept + Code/Analogy Split Screen) -> 3. The Connection (Animated Flowchart) -> 4. Real-World Application (Isometric View) -> 5. Synthesis (Mission Complete HUD).""",

    "mindmap": "",

    "flashcards": """Gere um deck completo de Cartões Didáticos (Flashcards) de recuperação ativa (Active Recall) para esta aula em Português do Brasil, utilizando estritamente o seguinte formato Markdown compatível com o parser do Study OS:

# Flashcards da Aula

## Card 1
**Q:** [Pergunta conceitual, arquitetural ou de análise prática]
**A:** [Resposta direta, densa e precisa explicando o mecanismo e o porquê]

---

## Card 2
**Q:** [Pergunta 2...]
**A:** [Resposta 2...]

Gere entre 10 e 15 cartões cobrindo os conceitos principais, trade-offs e armadilhas comuns da aula.""",

    "quiz": """Gere um Simulador Tático de Questões (Quiz) para esta aula em Português do Brasil, utilizando estritamente o seguinte formato Markdown compatível com o parser do Study OS:

# Questionário Tático da Aula

## Question 1
[Enunciado contextualizado com cenário de engenharia ou problema prático da aula]

- [ ] Alternativa incorreta plausível A
- [x] Alternativa correta com justificativa técnica sólida B
- [ ] Alternativa incorreta plausível C
- [ ] Alternativa incorreta plausível D

**Hint:** [Dica tática que guia o raciocínio sem entregar a resposta diretamente]

---

Gere entre 6 e 10 questões de alto nível analítico.""",

    "relatorio": """Gere um Relatório Técnico Executivo (`relatorio.md`) completo desta aula em Português do Brasil (Markdown estruturado), contendo:
1. `# Relatório Técnico — [Título da Aula]`
2. `## Executive Summary` (Visão arquitetural e síntese executiva)
3. `## Pilares Fundamentais & Mecânica Interna` (Análise profunda dos conceitos)
4. `## Matriz de Trade-offs & Decisões de Projeto` (Tabela comparativa)
5. `## Armadilhas Críticas (Pitfalls) & Mitigação`
6. `## Glossário de Alta Precisão`"""
}


def carregar_prompts_json() -> Dict[str, Any]:
    """Carrega os prompts oficiais de `prompts.json` se disponível."""
    if PROMPTS_JSON_PATH.exists():
        try:
            return json.loads(PROMPTS_JSON_PATH.read_text(encoding="utf-8-sig"))
        except Exception as e:
            print(f"⚠️ Erro ao carregar prompts.json: {e}")
    return {}


PROMPTS_JSON_CARREGADOS = carregar_prompts_json()


def adaptar_prompt_para_aula(
    texto_prompt: str,
    aula_nome: str = "",
    aula_titulo: str = "",
    materia_nome: str = ""
) -> str:
    """
    Substitui placeholders genéricos dos prompts (`[FOR FOCUS, INSERT LESSON NUMBER ( )]`,
    `[INSERT LESSON CONTENT OR TOPIC HERE]`, `[TOPIC NAME]`, `[Topic]`, `[Matéria]`,
    `[Subject]`, `[NOME GERAL DA MATÉRIA]`, `[FULL REVIEW]`, `[ALL COVERED THEMES]`)
    pelo contexto real da aula e matéria.
    """
    raw = str(texto_prompt or "")
    if not raw:
        return ""

    titulo_final = str(aula_titulo or aula_nome or "Aula").strip()
    if aula_nome and aula_titulo and aula_nome.lower() not in aula_titulo.lower():
        titulo_final = f"{aula_nome} — {aula_titulo}"
    materia_final = str(materia_nome or "Disciplina").strip()
    contexto_completo = f"{titulo_final} (Matéria: {materia_final})"

    substituicoes = [
        (r"\[FOR FOCUS,\s*INSERT LESSON NUMBER\s*\(\s*\)\]", f"Foco na {contexto_completo}"),
        (r"\[INSERT LESSON CONTENT OR TOPIC HERE\]", contexto_completo),
        (r"\[TOPIC NAME\]", titulo_final),
        (r"\[Topic\]", titulo_final),
        (r"\[Matéria\]", materia_final),
        (r"\[Subject\]", f"{materia_final} — {titulo_final}"),
        (r"\[NOME GERAL DA MATÉRIA\]", f"{materia_final} — {titulo_final}"),
        (r"\[FULL REVIEW\]", contexto_completo),
        (r"\[ALL COVERED THEMES\]", contexto_completo),
    ]

    resultado = raw
    for padrao, valor in substituicoes:
        resultado = re.sub(padrao, valor, resultado, flags=re.IGNORECASE)
    return resultado


CONFIG_PADRAO_NOTEBOOKLM: Dict[str, Dict[str, Any]] = {
    "video": {
        "formato": "Video explicativo",
        "escolher_estilo_visual": "Visual personalizado",
        "foco_video": "",  # Sempre vazio conforme especificação
        "resumo_label": "Video explicativo • Visual personalizado"
    },
    "relatorio": {
        "formato": "Documento",
        "modelo": "Crie do zero",
        "resumo_label": "Documento • Crie do zero"
    },
    "quiz": {
        "numero_questoes": "Mais",
        "nivel_dificuldade": "Média",
        "incluir_imagens": True,
        "tipos_perguntas": [
            "Uma resposta correta",
            "Mais de uma resposta correta",
            "Preencher a lacuna",
            "Resposta curta"
        ],
        "resumo_label": "Mais questões • Dificuldade Média • Imagens + Todos os tipos"
    },
    "audio": {
        "formato": "Análise detalhada",
        "resumo_label": "Análise detalhada"
    },
    "slides": {
        "formato": "Apresentação detalhada",
        "duracao": "Padrão",
        "resumo_label": "Apresentação detalhada • Duração Padrão"
    },
    "mindmap": {
        "modo": "Padrão de fábrica",
        "prompt": "",
        "resumo_label": "Padrão de fábrica"
    },
    "flashcards": {
        "numero_cards": "Mais",
        "nivel_dificuldade": "Média padrão",
        "incluir_imagens": True,
        "resumo_label": "Mais cards • Média padrão • Com imagens"
    },
    "infografico": {
        "escolher_estilo_visual": "Seleção automática",
        "orientacao": "Paisagem",
        "nivel_detalhamento": "Padrão",
        "resumo_label": "Seleção automática • Paisagem • Detalhamento Padrão"
    }
}


def construir_config_geracao_artefato(job: Dict[str, Any]) -> Dict[str, Any]:
    """
    Constrói a configuração completa de geração do artefato combinando
    `CONFIG_PADRAO_NOTEBOOKLM` com os prompts de `prompts.json` adaptados
    para a aula/matéria específica do job.
    """
    tipo = str(job.get("tipo_artefato") or "").lower()
    aula_nome = str(job.get("aula_nome") or job.get("aula_id") or "Aula")
    aula_titulo = str(job.get("aula_titulo") or aula_nome)
    materia_nome = str(job.get("materia_nome") or job.get("materia_id") or "Matéria")
    prompts_raw = PROMPTS_JSON_CARREGADOS or carregar_prompts_json()

    base_cfg = dict(CONFIG_PADRAO_NOTEBOOKLM.get(tipo, {}))

    if tipo == "video":
        video_obj = prompts_raw.get("Video Summary") if isinstance(prompts_raw.get("Video Summary"), dict) else {}
        style_raw = video_obj.get("style") or PROMPTS_FIXOS.get("video", "")
        focus_raw = video_obj.get("focus") or PROMPTS_FIXOS.get("video", "")
        base_cfg["estilo_visual_personalizado"] = adaptar_prompt_para_aula(style_raw, aula_nome, aula_titulo, materia_nome)
        base_cfg["foco_video"] = ""
        base_cfg["assunto_personalizado"] = adaptar_prompt_para_aula(focus_raw, aula_nome, aula_titulo, materia_nome)
        base_cfg["prompt_final"] = f"{base_cfg['assunto_personalizado']}\n\n[VISUAL STYLE]: {base_cfg['estilo_visual_personalizado']}"

    elif tipo == "relatorio":
        raw_p = prompts_raw.get("Reports") or PROMPTS_FIXOS.get("relatorio", "")
        base_cfg["descricao_relatorio"] = adaptar_prompt_para_aula(raw_p, aula_nome, aula_titulo, materia_nome)
        base_cfg["prompt_final"] = base_cfg["descricao_relatorio"]

    elif tipo == "quiz":
        raw_p = prompts_raw.get("Quiz") or PROMPTS_FIXOS.get("quiz", "")
        base_cfg["tema"] = adaptar_prompt_para_aula(raw_p, aula_nome, aula_titulo, materia_nome)
        base_cfg["prompt_final"] = base_cfg["tema"]

    elif tipo == "audio":
        raw_p = prompts_raw.get("Audio Summary") or PROMPTS_FIXOS.get("audio", "")
        base_cfg["foco_apresentadores"] = adaptar_prompt_para_aula(raw_p, aula_nome, aula_titulo, materia_nome)
        base_cfg["prompt_final"] = base_cfg["foco_apresentadores"]

    elif tipo == "slides":
        raw_p = prompts_raw.get("Slide Presentation") or PROMPTS_FIXOS.get("slides", "")
        base_cfg["descricao_slides"] = adaptar_prompt_para_aula(raw_p, aula_nome, aula_titulo, materia_nome)
        base_cfg["prompt_final"] = base_cfg["descricao_slides"]

    elif tipo == "mindmap":
        base_cfg["modo"] = "Padrão de fábrica"
        base_cfg["prompt"] = ""
        base_cfg["prompt_final"] = ""

    elif tipo == "flashcards":
        raw_p = prompts_raw.get("Flashcards") or PROMPTS_FIXOS.get("flashcards", "")
        base_cfg["tema"] = adaptar_prompt_para_aula(raw_p, aula_nome, aula_titulo, materia_nome)
        base_cfg["prompt_final"] = base_cfg["tema"]

    elif tipo == "infografico":
        raw_p = prompts_raw.get("Infographic") or PROMPTS_FIXOS.get("infografico", "")
        base_cfg["descricao_infografico"] = adaptar_prompt_para_aula(raw_p, aula_nome, aula_titulo, materia_nome)
        base_cfg["prompt_final"] = base_cfg["descricao_infografico"]

    return base_cfg


# ==============================================================================
# 🛠️ UTILITÁRIOS DE EXTRAÇÃO E MANIPULAÇÃO DO BANCO (db.json & Firebase)
# ==============================================================================
def extrair_notebook_id(notebook_url: str) -> str:
    """Extrai o ID limpo do caderno a partir da URL do Google NotebookLM."""
    raw = str(notebook_url or "").strip()
    if not raw:
        return ""
    m = re.search(r"notebook/([a-zA-Z0-9_-]+)", raw)
    if m:
        return m.group(1)
    # Se já for um ID puro
    if re.match(r"^[a-zA-Z0-9_-]{10,}$", raw) and "http" not in raw:
        return raw
    return ""


def slugify_py(texto: str) -> str:
    """Normaliza string em slug compatível com o frontend (`domHelpers.js`)."""
    import unicodedata
    s = "".join(
        c for c in unicodedata.normalize("NFD", str(texto or ""))
        if unicodedata.category(c) != "Mn"
    )
    s = re.sub(r"[^a-zA-Z0-9]+", "-", s.lower()).strip("-")
    return s or "item"


def _extrair_partes_caminho_job(job: Dict[str, Any]) -> Tuple[str, str, str]:
    """Extrai `(semestre, materia, aula)` do job ou da estrutura de `pasta_aula`."""
    pasta = str(job.get("pasta_aula") or "").replace("\\", "/").strip("/")
    partes = [p.strip() for p in pasta.split("/") if p.strip()]
    sem = str(job.get("semestre_nome") or (partes[0] if len(partes) >= 1 else "") or "").strip()
    mat = str(job.get("materia_nome") or (partes[1] if len(partes) >= 2 else "") or job.get("materia_id") or "").strip()
    aula = str(job.get("aula_nome") or (partes[2] if len(partes) >= 3 else "") or job.get("aula_id") or "").strip()
    if not sem:
        ref_id = str(job.get("materia_id") or job.get("aula_id") or "")
        m_sem_id = re.match(r"^(\d+)[°º-]?\s*semestre", ref_id, flags=re.IGNORECASE)
        if m_sem_id:
            sem = f"{m_sem_id.group(1)}° semestre"
    return sem, mat, aula


def _chave_semestre_py(sem_txt: str) -> Tuple[int, int, str]:
    """Ordena 1° semestre -> 2° -> ... -> 8° primeiro; pastas sem número (ex.: Cursos) por último."""
    norm = slugify_py(sem_txt) if sem_txt else ""
    m = re.search(r"(\d+)", sem_txt or "")
    if m:
        return (0, int(m.group(1)), norm)
    return (1, 9999, norm or "zzz")


def _chave_aula_py(aula_txt: str) -> Tuple[int, int, str]:
    """Ordena Aula 01 -> Aula 02 -> ... -> Aula 10 numericamente e deixa Aula Conclusão no final."""
    low = str(aula_txt or "").lower()
    norm = slugify_py(aula_txt) if aula_txt else ""
    is_conclusao = 1 if "conclus" in low else 0
    m = re.search(r"(\d+)", aula_txt or "")
    num = int(m.group(1)) if (m and not is_conclusao) else 9999
    return (is_conclusao, num, norm or "zzz")


def chave_ordenacao_hierarquica_job(job: Dict[str, Any]) -> Tuple[Any, ...]:
    """
    Ordem hierárquica estrita de execução da fila:
    1º Semestre (1° -> 2° -> ... -> 8° -> Cursos/outros)
    2º Matéria inteira dentro do semestre
    3º Aula (Aula 01 -> Aula 02 -> ... -> Aula Conclusão)
    4º Artefato na aula (mindmap -> flashcards -> quiz -> relatorio -> infografico -> slides -> audio -> video)
    5º Timestamp de entrada (desempate)
    """
    sem_txt, mat_txt, aula_txt = _extrair_partes_caminho_job(job)
    sem_key = _chave_semestre_py(sem_txt)
    mat_norm = slugify_py(mat_txt) if mat_txt else "zzz"
    aula_key = _chave_aula_py(aula_txt)
    tipo_prio = PRIORIDADE_VIA_ARTEFATO.get(str(job.get("tipo_artefato") or "").strip().lower(), 99)
    ts = int(job.get("timestamp") or 0)
    return (sem_key, mat_norm, aula_key, tipo_prio, ts)


def firebase_url_auth(path: str) -> str:
    base = f"{FIREBASE_URL.rstrip('/')}/{path.lstrip('/')}"
    if FIREBASE_SECRET:
        sep = "&" if "?" in base else "?"
        return f"{base}{sep}auth={FIREBASE_SECRET}"
    return base


def firebase_get(caminho: str) -> Any:
    url = firebase_url_auth(f"{caminho.strip('/')}.json")
    req = urllib.request.Request(url, headers={"User-Agent": "StudyOS-StudioWorker/2.0"}, method="GET")
    try:
        with urllib.request.urlopen(req, timeout=20) as resp:
            raw = resp.read().decode("utf-8")
            return json.loads(raw) if raw else None
    except Exception as e:
        print(f"⚠️ [Firebase] Falha ao ler {caminho}: {e}")
        return None


def firebase_put(caminho: str, dados: Any) -> bool:
    url = firebase_url_auth(f"{caminho.strip('/')}.json")
    body = json.dumps(dados, ensure_ascii=False).encode("utf-8")
    req = urllib.request.Request(url, data=body, headers={"Content-Type": "application/json"}, method="PUT")
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            return resp.status in (200, 204)
    except Exception as e:
        print(f"⚠️ [Firebase] Falha ao sincronizar {caminho}: {e}")
        return False


def firebase_patch(caminho: str, dados: Any) -> bool:
    url = firebase_url_auth(f"{caminho.strip('/')}.json")
    body = json.dumps(dados, ensure_ascii=False).encode("utf-8")
    req = urllib.request.Request(url, data=body, headers={"Content-Type": "application/json"}, method="PATCH")
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            return resp.status in (200, 204)
    except Exception as e:
        print(f"⚠️ [Firebase] Falha ao atualizar (PATCH) {caminho}: {e}")
        return False


def firebase_delete(caminho: str) -> bool:
    url = firebase_url_auth(f"{caminho.strip('/')}.json")
    req = urllib.request.Request(url, method="DELETE")
    try:
        with urllib.request.urlopen(req, timeout=20) as resp:
            return resp.status in (200, 204)
    except Exception as e:
        print(f"⚠️ [Firebase] Falha ao deletar {caminho}: {e}")
        return False


def firebase_get_shallow(caminho: str) -> Tuple[bool, Optional[Dict[str, Any]]]:
    """
    Lista apenas as chaves de uma coleção no Firebase RTDB (`?shallow=true`),
    baixando poucos bytes sem trafegar os objetos completos.
    Retorna `(sucesso_http, dict_de_chaves_ou_None)`.
    """
    url = firebase_url_auth(f"{caminho.strip('/')}.json?shallow=true")
    req = urllib.request.Request(url, headers={"User-Agent": "StudyOS-StudioWorker/2.0"}, method="GET")
    try:
        with urllib.request.urlopen(req, timeout=20) as resp:
            raw = resp.read().decode("utf-8")
            data = json.loads(raw) if raw else None
            return True, (data if isinstance(data, dict) else None)
    except Exception as e:
        print(f"⚠️ [Firebase] Falha ao listar chaves (?shallow=true) de {caminho}: {e}")
        return False, None


def firebase_limpar_colecao(caminho: str, chaves_extras: Optional[List[str]] = None) -> Dict[str, Any]:
    """
    Apaga 100% dos filhos de uma coleção no Firebase RTDB (ex.: `/fila_studio`) usando
    `GET ?shallow=true` + `PATCH` em lotes de 200 chaves com valor `null` (respeitando
    as regras de segurança por `$job_id`, onde `DELETE /fila_studio.json` retornaria 401).
    Faz verificação final confirmando 0 chaves restantes no banco.
    """
    caminho_limpo = caminho.strip("/")
    extras = [str(k).strip() for k in (chaves_extras or []) if str(k).strip()]
    total_removidos = 0

    for tentativa in range(2):
        ok_list, remoto = firebase_get_shallow(caminho_limpo)
        chaves_remotas = list(remoto.keys()) if isinstance(remoto, dict) else []
        if tentativa == 0:
            chaves_alvo = list(dict.fromkeys(chaves_remotas + extras))
        else:
            chaves_alvo = chaves_remotas

        if not chaves_alvo:
            return {
                "ok": ok_list,
                "removidos": total_removidos,
                "restantes": 0 if ok_list else -1
            }

        for i in range(0, len(chaves_alvo), 200):
            fatia = chaves_alvo[i:i + 200]
            mapa_nulos = {k: None for k in fatia}
            if firebase_patch(caminho_limpo, mapa_nulos):
                total_removidos += len(fatia)
            else:
                for k in fatia:
                    if firebase_delete(f"{caminho_limpo}/{urllib.parse.quote(k, safe='')}"):
                        total_removidos += 1

    ok_verif, restante_dict = firebase_get_shallow(caminho_limpo)
    restantes = len(restante_dict) if isinstance(restante_dict, dict) else (0 if ok_verif else -1)
    return {
        "ok": bool(ok_verif and restantes == 0),
        "removidos": total_removidos,
        "restantes": restantes
    }


def firebase_publicar_meta_fila(ts: int, acao: str = "", limpo_em: int = 0) -> bool:
    """Atualiza `/fila_studio_meta` com fallback seguro caso regras restrinjam campos extras."""
    payload: Dict[str, Any] = {
        "atualizado_em": ts,
        "admin_gate": STUDIO_ADMIN_GATE
    }
    if acao:
        payload["acao"] = acao
    if limpo_em > 0:
        payload["limpo_em"] = limpo_em
    if firebase_put("fila_studio_meta", payload):
        return True
    if acao or limpo_em > 0:
        return firebase_put("fila_studio_meta", {"atualizado_em": ts, "admin_gate": STUDIO_ADMIN_GATE})
    return False


def resolver_staging_file_path(job: Dict[str, Any], staging_dir: Optional[Path] = None) -> Path:
    """
    Resolve o caminho físico local temporário em `staging/` para download inicial.
    Artefatos visuais em revisão são enviados em seguida para `_staging_studio`
    no Google Drive via Drive API v3 para visualização remota sem depender de atraso do DriveFS.
    """
    staging_rel = str(job.get("caminho_staging") or "").replace("\\", "/").lstrip("/")
    nome_arq = Path(staging_rel).name if staging_rel else f"{job.get('id', 'job')}_{job.get('tipo_artefato', 'art')}.dat"
    base = staging_dir or STAGING_DIR
    base.mkdir(parents=True, exist_ok=True)
    return base / nome_arq


_CACHE_PASTA_STAGING_DRIVE_ID: str = ""
_CACHE_PASTA_AULA_IDS: Dict[str, str] = {}


def _importar_gerar_db() -> Any:
    if str(SCRIPT_DIR) not in sys.path:
        sys.path.insert(0, str(SCRIPT_DIR))
    import gerar_db  # type: ignore
    return gerar_db


def obter_token_drive_silencioso(permitir_oauth_interativo: bool = False) -> str:
    """
    Obtém um access_token válido do Google Drive (`token.json` / `token.pickle`)
    sem abrir popups de navegador durante o loop automático em background.
    """
    try:
        gerar_db = _importar_gerar_db()
        cfg = gerar_db.obter_config_oauth()
        token_json = getattr(gerar_db, "TOKEN_JSON_PATH", SCRIPT_DIR / "token.json")
        if token_json.exists():
            dados = json.loads(token_json.read_text(encoding="utf-8"))
            at = dados.get("access_token") or dados.get("token") or ""
            rt = dados.get("refresh_token") or ""
            cid = dados.get("client_id") or cfg.get("client_id", "")
            csec = dados.get("client_secret") or cfg.get("client_secret", "")
            turi = dados.get("token_uri") or cfg.get("token_uri", "https://oauth2.googleapis.com/token")
            if at:
                try:
                    req = urllib.request.Request(
                        "https://www.googleapis.com/drive/v3/about?fields=user",
                        headers={"Authorization": f"Bearer {at}"}
                    )
                    with urllib.request.urlopen(req, timeout=8) as resp:
                        if resp.status == 200:
                            return at
                except Exception:
                    pass
            if rt:
                novo = gerar_db.renovar_access_token_http(rt, cid, csec, turi)
                if novo:
                    dados["access_token"] = novo
                    dados["token"] = novo
                    token_json.write_text(json.dumps(dados, indent=2), encoding="utf-8")
                    return novo
        if permitir_oauth_interativo:
            return str(gerar_db.obter_access_token_valido() or "")
    except Exception:
        pass
    return ""


def _drive_request_json(
    token: str,
    url: str,
    method: str = "GET",
    body: Optional[Dict[str, Any]] = None,
    timeout: int = 20
) -> Dict[str, Any]:
    headers = {"Authorization": f"Bearer {token}"}
    data: Optional[bytes] = None
    if body is not None:
        headers["Content-Type"] = "application/json; charset=utf-8"
        data = json.dumps(body, ensure_ascii=False).encode("utf-8")
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        raw = resp.read().decode("utf-8", errors="ignore").strip()
        return json.loads(raw) if raw else {}


def _tornar_arquivo_drive_publico(token: str, file_id: str) -> bool:
    if not token or not file_id:
        return False
    try:
        url = f"https://www.googleapis.com/drive/v3/files/{file_id}/permissions?fields=id&supportsAllDrives=true"
        _drive_request_json(token, url, method="POST", body={"type": "anyone", "role": "reader"})
        return True
    except Exception:
        return False


def _garantir_pasta_filha_drive(token: str, parent_id: str, nome_pasta: str, criar_se_ausente: bool = True) -> str:
    if not token or not parent_id or not nome_pasta:
        return ""
    try:
        nome_esc = nome_pasta.replace("\\", "\\\\").replace("'", "\\'")
        query = (
            f"'{parent_id}' in parents and name = '{nome_esc}' "
            "and mimeType = 'application/vnd.google-apps.folder' and trashed = false"
        )
        params = urllib.parse.urlencode({
            "q": query,
            "fields": "files(id, name)",
            "pageSize": 5,
            "supportsAllDrives": "true",
            "includeItemsFromAllDrives": "true"
        })
        res = _drive_request_json(token, f"https://www.googleapis.com/drive/v3/files?{params}")
        files = res.get("files") or []
        if files:
            return str(files[0].get("id") or "")

        # Busca tolerante (caso emojis/espaços variem no Drive)
        q_all = f"'{parent_id}' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false"
        params_all = urllib.parse.urlencode({
            "q": q_all,
            "fields": "files(id, name)",
            "pageSize": 100,
            "supportsAllDrives": "true",
            "includeItemsFromAllDrives": "true"
        })
        res_all = _drive_request_json(token, f"https://www.googleapis.com/drive/v3/files?{params_all}")
        alvo_norm = slugify_py(nome_pasta)
        for item in (res_all.get("files") or []):
            if slugify_py(item.get("name", "")) == alvo_norm:
                return str(item.get("id") or "")

        if not criar_se_ausente:
            return ""
        criada = _drive_request_json(
            token,
            "https://www.googleapis.com/drive/v3/files?fields=id&supportsAllDrives=true",
            method="POST",
            body={
                "name": nome_pasta,
                "mimeType": "application/vnd.google-apps.folder",
                "parents": [parent_id]
            }
        )
        return str(criada.get("id") or "")
    except Exception:
        return ""


def _obter_pasta_staging_drive_id(token: str) -> str:
    global _CACHE_PASTA_STAGING_DRIVE_ID
    if _CACHE_PASTA_STAGING_DRIVE_ID:
        return _CACHE_PASTA_STAGING_DRIVE_ID
    try:
        gerar_db = _importar_gerar_db()
        raiz_id = getattr(gerar_db, "PASTA_RAIZ_ID_PADRAO", "1_E2qxLk4inkCoT2dccBjJ1GL2HVTDU2N")
    except Exception:
        raiz_id = "1_E2qxLk4inkCoT2dccBjJ1GL2HVTDU2N"
    fid = _garantir_pasta_filha_drive(token, raiz_id, "_staging_studio", criar_se_ausente=True)
    if fid:
        _tornar_arquivo_drive_publico(token, fid)
        _CACHE_PASTA_STAGING_DRIVE_ID = fid
    return fid


def _localizar_pasta_aula_drive_id(token: str, pasta_rel: str) -> str:
    """Resolve o ID da pasta da aula no Google Drive (via DriveFS SQLite ou API v3)."""
    norm_key = str(pasta_rel or "").replace("\\", "/").strip("/")
    if not norm_key:
        return ""
    if norm_key in _CACHE_PASTA_AULA_IDS:
        return _CACHE_PASTA_AULA_IDS[norm_key]

    try:
        gerar_db = _importar_gerar_db()
        if hasattr(gerar_db, "extrair_ids_drivefs_local"):
            mapa = gerar_db.extrair_ids_drivefs_local() or {}
            cid = (mapa.get("por_caminho") or {}).get(norm_key.lower(), "")
            if cid:
                _CACHE_PASTA_AULA_IDS[norm_key] = cid
                return cid
        atual_id = getattr(gerar_db, "PASTA_RAIZ_ID_PADRAO", "1_E2qxLk4inkCoT2dccBjJ1GL2HVTDU2N")
    except Exception:
        atual_id = "1_E2qxLk4inkCoT2dccBjJ1GL2HVTDU2N"

    for parte in [p for p in norm_key.split("/") if p]:
        prox_id = _garantir_pasta_filha_drive(token, atual_id, parte, criar_se_ausente=True)
        if not prox_id:
            return ""
        atual_id = prox_id
    _CACHE_PASTA_AULA_IDS[norm_key] = atual_id
    return atual_id


def upload_arquivo_drive_multipart(
    caminho_arquivo: Path,
    parent_id: str,
    nome_destino: Optional[str] = None,
    mime_type: Optional[str] = None,
    substituir_mesmo_nome: bool = True
) -> str:
    """Faz upload direto de um arquivo para uma pasta no Google Drive e torna-o público."""
    if not caminho_arquivo.exists() or not parent_id:
        return ""
    token = obter_token_drive_silencioso()
    if not token:
        return ""

    nome = nome_destino or caminho_arquivo.name
    mtype = mime_type or mimetypes.guess_type(nome)[0] or "application/octet-stream"

    try:
        if substituir_mesmo_nome:
            nome_esc = nome.replace("\\", "\\\\").replace("'", "\\'")
            q = f"'{parent_id}' in parents and name = '{nome_esc}' and trashed = false"
            params = urllib.parse.urlencode({
                "q": q, "fields": "files(id)", "pageSize": 10,
                "supportsAllDrives": "true", "includeItemsFromAllDrives": "true"
            })
            exist = _drive_request_json(token, f"https://www.googleapis.com/drive/v3/files?{params}")
            for old_f in (exist.get("files") or []):
                deletar_arquivo_drive(old_f.get("id", ""), token=token)

        boundary = f"----StudyOSStudio{uuid.uuid4().hex}"
        metadata = json.dumps({"name": nome, "parents": [parent_id]}, ensure_ascii=False).encode("utf-8")
        file_bytes = caminho_arquivo.read_bytes()

        corpo = (
            f"--{boundary}\r\n"
            "Content-Type: application/json; charset=UTF-8\r\n\r\n"
        ).encode("utf-8") + metadata + (
            f"\r\n--{boundary}\r\n"
            f"Content-Type: {mtype}\r\n\r\n"
        ).encode("utf-8") + file_bytes + f"\r\n--{boundary}--\r\n".encode("utf-8")

        url = "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name&supportsAllDrives=true"
        req = urllib.request.Request(
            url,
            data=corpo,
            headers={
                "Authorization": f"Bearer {token}",
                "Content-Type": f"multipart/related; boundary={boundary}",
                "Content-Length": str(len(corpo))
            },
            method="POST"
        )
        with urllib.request.urlopen(req, timeout=180) as resp:
            res = json.loads(resp.read().decode("utf-8"))
        fid = str(res.get("id") or "")
        if fid:
            _tornar_arquivo_drive_publico(token, fid)
        return fid
    except Exception as exc:
        print(f"   ⚠️ [DriveUpload] Falha ao enviar '{nome}' para o Google Drive: {exc}")
        return ""


def mover_arquivo_drive_para_pasta_aula(
    file_id: str,
    pasta_rel: str,
    novo_nome: str
) -> str:
    """Move um arquivo já existente no Drive (`_staging_studio`) para a pasta da aula."""
    if not file_id:
        return ""
    token = obter_token_drive_silencioso()
    if not token:
        return ""
    dest_folder_id = _localizar_pasta_aula_drive_id(token, pasta_rel)
    if not dest_folder_id:
        return ""

    try:
        # Remove arquivo anterior de mesmo nome na pasta da aula (regeração)
        nome_esc = novo_nome.replace("\\", "\\\\").replace("'", "\\'")
        q = f"'{dest_folder_id}' in parents and name = '{nome_esc}' and trashed = false"
        params = urllib.parse.urlencode({
            "q": q, "fields": "files(id)", "pageSize": 10,
            "supportsAllDrives": "true", "includeItemsFromAllDrives": "true"
        })
        exist = _drive_request_json(token, f"https://www.googleapis.com/drive/v3/files?{params}")
        for old_f in (exist.get("files") or []):
            old_id = old_f.get("id", "")
            if old_id and old_id != file_id:
                deletar_arquivo_drive(old_id, token=token)

        info = _drive_request_json(
            token,
            f"https://www.googleapis.com/drive/v3/files/{file_id}?fields=parents&supportsAllDrives=true"
        )
        parents_antigos = ",".join(info.get("parents") or [])
        q_patch = {
            "addParents": dest_folder_id,
            "fields": "id,name,parents",
            "supportsAllDrives": "true"
        }
        if parents_antigos:
            q_patch["removeParents"] = parents_antigos
        patch_url = f"https://www.googleapis.com/drive/v3/files/{file_id}?" + urllib.parse.urlencode(q_patch)
        _drive_request_json(token, patch_url, method="PATCH", body={"name": novo_nome})
        _tornar_arquivo_drive_publico(token, file_id)
        return file_id
    except Exception as exc:
        print(f"   ⚠️ [DriveMove] Falha ao mover arquivo '{file_id}' para '{pasta_rel}': {exc}")
        return ""


def deletar_arquivo_drive(file_id: str, token: str = "") -> bool:
    """Exclui permanentemente (ou envia para lixeira) um arquivo no Google Drive por ID."""
    if not file_id:
        return False
    tk = token or obter_token_drive_silencioso()
    if not tk:
        return False
    try:
        url = f"https://www.googleapis.com/drive/v3/files/{file_id}?supportsAllDrives=true"
        req = urllib.request.Request(url, headers={"Authorization": f"Bearer {tk}"}, method="DELETE")
        with urllib.request.urlopen(req, timeout=20):
            return True
    except urllib.error.HTTPError as e:
        if e.code == 404:
            return True
        return False
    except Exception:
        return False


def tentar_extrair_drive_id_arquivo(caminho_arquivo: Path) -> str:
    """
    Descobre o Drive ID de um arquivo local no Google Drive Desktop consultando
    `gerar_db.extrair_ids_drivefs_local()` quando disponível.
    """
    if not caminho_arquivo.exists():
        return ""
    try:
        gerar_db = _importar_gerar_db()
        if hasattr(gerar_db, "extrair_ids_drivefs_local"):
            mapa = gerar_db.extrair_ids_drivefs_local() or {}
            nome_low = caminho_arquivo.name.strip().lower()
            fid = (mapa.get("por_nome") or {}).get(nome_low, "")
            if fid:
                return str(fid)
    except Exception:
        pass
    return ""


def montar_url_preview_drive(drive_id: str, tipo_artefato: str) -> str:
    if not drive_id:
        return ""
    if tipo_artefato == "infografico":
        return f"https://lh3.googleusercontent.com/d/{drive_id}=w2000"
    if tipo_artefato in ("slides", "video"):
        return f"https://drive.google.com/file/d/{drive_id}/preview"
    if tipo_artefato == "audio":
        return f"https://docs.google.com/uc?export=open&id={drive_id}"
    return f"https://drive.google.com/uc?export=download&id={drive_id}"


def limpar_flashcards_markdown_notebooklm(texto: str) -> str:
    """
    Converte wrappers literais `{'flashcardContentBlock': [{'type': 'text', 'content': '...'}]}`
    emitidos pelo `notebooklm-py` em Markdown limpo para exibição imediata no Study OS.
    """
    if not texto or "flashcardContentBlock" not in texto:
        return texto

    linhas_out: List[str] = []
    for linha in str(texto).splitlines():
        if "flashcardContentBlock" in linha and "{" in linha:
            idx = linha.find("{")
            prefixo = linha[:idx]
            bruto = linha[idx:].strip()
            obj: Any = None
            try:
                obj = ast.literal_eval(bruto)
            except Exception:
                try:
                    obj = json.loads(bruto)
                except Exception:
                    obj = None

            if isinstance(obj, dict) and isinstance(obj.get("flashcardContentBlock"), list):
                partes: List[str] = []
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


def carregar_db_local() -> Optional[Dict[str, Any]]:
    for cand in (DB_PERSONAL_PATH, DB_JSON_PATH):
        if cand.exists():
            try:
                raw_text = cand.read_text(encoding="utf-8-sig")
                try:
                    return json.loads(raw_text)
                except json.JSONDecodeError:
                    # Corrige barras invertidas de LaTeX (\Omega, \Theta) não escapadas no JSON
                    sanitized = re.sub(r'\\(?![/\"\\bfnrtu])', r'\\\\', raw_text)
                    return json.loads(sanitized)
            except Exception as e:
                print(f"⚠️ Erro ao ler {cand.name}: {e}")
    return None


_CLOUD_DB_SYNC_LOCK = threading.RLock()


def extrair_titulo_h1_markdown_py(texto: str) -> str:
    """Extrai e limpa o título principal H1 de um texto Markdown (máx. 200 caracteres)."""
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


def _eh_novo_artefato_node_py(item: Dict[str, Any]) -> bool:
    role = str(item.get("artifactRole") or "").strip().lower()
    nome_low = str(item.get("nome") or "").strip().lower()
    return role in TIPOS_AUTO_APROVACAO or nome_low.endswith(("mapa-mental.json", "flashcards.md", "quiz.md", "relatorio.md"))


def extrair_conteudo_aula_para_firebase(aula_node: Dict[str, Any]) -> Dict[str, Any]:
    """Extrai apenas o conteúdo pesado (MDs e artefatos inline) de uma única aula para `/db_conteudo/{aula_id}`."""
    mds: Dict[str, str] = {}
    artifacts: Dict[str, Dict[str, Any]] = {}
    if not isinstance(aula_node, dict):
        return {"admin_gate": STUDIO_ADMIN_GATE, "atualizado_em": int(time.time() * 1000), "mds": mds, "artifacts": artifacts}

    filhos = aula_node.get("filhos") if isinstance(aula_node.get("filhos"), list) else (
        aula_node.get("arquivos") if isinstance(aula_node.get("arquivos"), list) else []
    )

    def _coletar_arqs(lista: List[Any]) -> None:
        for item in lista:
            if not isinstance(item, dict):
                continue
            if item.get("tipo") == "pasta" or isinstance(item.get("filhos"), list):
                _coletar_arqs(item.get("filhos") or [])
                continue
            nome = str(item.get("nome") or "").strip()
            nome_low = nome.lower()
            role = str(item.get("artifactRole") or "").strip().lower()
            if not role:
                if nome_low.endswith("mapa-mental.json"):
                    role = "mindmap"
                elif nome_low.endswith("flashcards.md"):
                    role = "flashcards"
                elif nome_low.endswith("quiz.md"):
                    role = "quiz"
                elif nome_low.endswith("relatorio.md"):
                    role = "relatorio"

            if role in TIPOS_AUTO_APROVACAO:
                entry: Dict[str, Any] = {"nome": nome}
                if role == "mindmap" and item.get("conteudoJson") is not None:
                    entry["conteudoJson"] = item["conteudoJson"]
                if item.get("conteudoTexto"):
                    entry["conteudoTexto"] = item["conteudoTexto"]
                if "conteudoJson" in entry or "conteudoTexto" in entry:
                    artifacts[role] = entry
            elif (nome_low.endswith((".md", ".markdown")) or str(item.get("tipo", "")).lower() in ("md", "markdown")) and item.get("conteudoTexto"):
                if nome:
                    mds[nome] = item["conteudoTexto"]

    _coletar_arqs(filhos)

    raw_arts = aula_node.get("artifacts")
    if isinstance(raw_arts, dict):
        for role in TIPOS_AUTO_APROVACAO:
            val = raw_arts.get(role)
            if isinstance(val, dict):
                entry = {"nome": str(val.get("nome") or TIPOS_ARTEFATOS_CONFIG[role]["nome_padrao"])}
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


def _copiar_no_leve(valor: Any) -> Any:
    if isinstance(valor, list):
        return [_copiar_no_leve(v) for v in valor]
    if not isinstance(valor, dict):
        return valor
    out: Dict[str, Any] = {}
    h1_salvo = str(valor.get("tituloH1") or "").strip()
    if not h1_salvo and isinstance(valor.get("conteudoTexto"), str) and not _eh_novo_artefato_node_py(valor):
        h1_salvo = extrair_titulo_h1_markdown_py(valor["conteudoTexto"])
    for k, v in valor.items():
        if k in ("conteudoTexto", "conteudoJson"):
            continue
        out[k] = _copiar_no_leve(v)
    if h1_salvo:
        out["tituloH1"] = h1_salvo
    return out


def gerar_catalogo_leve_db(db_data: Dict[str, Any]) -> Dict[str, Any]:
    """
    Gera versão enxuta do banco (sem `conteudoTexto`/`conteudoJson` inline, preservando `tituloH1`
    e metadados de artefatos) reduzindo de ~8.2 MB para ~1.4 MB no Firebase `/db_json`.
    """
    if not isinstance(db_data, dict):
        return {}
    leve = _copiar_no_leve(db_data)
    leve["admin_gate"] = STUDIO_ADMIN_GATE
    if not leve.get("atualizado_em"):
        leve["atualizado_em"] = int(time.time() * 1000)
    return leve


def salvar_db_local_e_nuvem(
    db_data: Dict[str, Any],
    aula_id_modificada: str = "",
    aula_node_modificada: Optional[Dict[str, Any]] = None
) -> bool:
    salvou = False
    agora_ms = int(time.time() * 1000)
    if isinstance(db_data, dict):
        db_data["admin_gate"] = STUDIO_ADMIN_GATE
        db_data["atualizado_em"] = agora_ms
    try:
        DB_PERSONAL_PATH.write_text(json.dumps(db_data, ensure_ascii=False, indent=2), encoding="utf-8")
        salvou = True
    except Exception as e:
        print(f"⚠️ Erro ao salvar {DB_PERSONAL_PATH.name}: {e}")

    def _sync_nuvem() -> None:
        with _CLOUD_DB_SYNC_LOCK:
            if aula_id_modificada and isinstance(aula_node_modificada, dict):
                payload_aula = extrair_conteudo_aula_para_firebase(aula_node_modificada)
                firebase_put(f"db_conteudo/{aula_id_modificada}", payload_aula)
            catalogo_leve = gerar_catalogo_leve_db(db_data)
            firebase_put("db_json", catalogo_leve)
            firebase_put("db_meta", {
                "atualizado_em": agora_ms,
                "modo": "catalogo_leve",
                "admin_gate": STUDIO_ADMIN_GATE
            })

    threading.Thread(target=_sync_nuvem, daemon=True).start()
    return salvou


def localizar_aula_no_db(
    db_data: Dict[str, Any],
    materia_id: str = "",
    aula_id: str = "",
    pasta_aula: str = "",
    notebook_url: str = ""
) -> Optional[Dict[str, Any]]:
    """
    Localiza o nó da aula e da matéria dentro da árvore `db.json` (tanto no formato
    bruto `filhos` quanto no formato normalizado `semestres`).
    Retorna `{ "aula_node": dict, "materia_node": dict, "semestre_node": dict }`.
    """
    if not db_data or not isinstance(db_data, dict):
        return None

    pasta_norm = str(pasta_aula or "").replace("\\", "/").strip("/").lower()
    nb_id_alvo = extrair_notebook_id(notebook_url)

    # Formato 1: Árvore com `filhos` (db.json padrão)
    for sem in db_data.get("filhos", []):
        sem_nome = sem.get("nome", "")
        for mat in sem.get("filhos", []):
            mat_nome = mat.get("nome", "")
            # Remove emoji inicial para gerar slug igual ao store.js
            mat_limpo = re.sub(r"^[^\w\s]+\s*", "", mat_nome).strip() or mat_nome
            mat_slug = slugify_py(f"{sem_nome}-{mat_limpo}")
            mat_id_node = str(mat.get("id", ""))

            for aula in mat.get("filhos", []):
                if aula.get("tipo") != "pasta" and not isinstance(aula.get("filhos"), list):
                    continue
                aula_nome = aula.get("nome", "")
                aula_slug = slugify_py(f"{sem_nome}-{mat_limpo}-{aula_nome}")
                aula_id_node = str(aula.get("id", ""))
                aula_local = str(aula.get("local", "")).replace("\\", "/").strip("/").lower()
                aula_nb = extrair_notebook_id(
                    aula.get("linkNotebookLLM") or aula.get("linkNotebookLM") or ""
                )

                if aula_id and aula_id in (aula_slug, aula_id_node):
                    return {"aula_node": aula, "materia_node": mat, "semestre_node": sem}
                if pasta_norm and aula_local and aula_local == pasta_norm:
                    return {"aula_node": aula, "materia_node": mat, "semestre_node": sem}
                if nb_id_alvo and aula_nb and aula_nb == nb_id_alvo:
                    if not materia_id or materia_id in (mat_slug, mat_id_node):
                        return {"aula_node": aula, "materia_node": mat, "semestre_node": sem}

    # Formato 2: Árvore normalizada com `semestres`
    for sem in db_data.get("semestres", []):
        for mat in sem.get("disciplinas", []):
            for aula in mat.get("aulas", []):
                aula_local = str(aula.get("local", "")).replace("\\", "/").strip("/").lower()
                aula_nb = extrair_notebook_id(aula.get("linkNotebookLLM") or "")
                if aula_id and aula.get("id") == aula_id:
                    return {"aula_node": aula, "materia_node": mat, "semestre_node": sem}
                if pasta_norm and aula_local == pasta_norm:
                    return {"aula_node": aula, "materia_node": mat, "semestre_node": sem}
                if nb_id_alvo and aula_nb == nb_id_alvo:
                    return {"aula_node": aula, "materia_node": mat, "semestre_node": sem}

    return None


def _item_corresponde_ao_tipo_studio(item: Dict[str, Any], tipo_art: str) -> bool:
    """
    Verifica estritamente se um arquivo da aula corresponde ao tipo Studio esperado.
    Impede confusão entre Camada 2A (.jpg Sketchnote) e Camada 2B (.png Infográfico NotebookLM).
    """
    if not isinstance(item, dict) or not tipo_art:
        return False

    item_nome = str(item.get("nome") or "").strip().lower()
    item_local = str(item.get("local") or "").replace("\\", "/").strip().lower()
    item_role = str(item.get("artifactRole") or "").strip().lower()
    item_mime = str(item.get("mimeType") or "").strip().lower()
    raw_tipo = str(item.get("tipo") or "").strip().lower()

    ext_nome = item_nome.rsplit(".", 1)[-1] if "." in item_nome else ""
    if not ext_nome and "." in item_local:
        ext_nome = item_local.rsplit("/", 1)[-1].rsplit(".", 1)[-1]
    ext_real = ext_nome or (raw_tipo if raw_tipo not in ("arquivo", "pasta", "") else "")

    cfg = TIPOS_ARTEFATOS_CONFIG.get(tipo_art, {})
    eh_novo_artefato = (
        item_role in TIPOS_AUTO_APROVACAO
        or item_nome.endswith(("mapa-mental.json", "flashcards.md", "quiz.md", "relatorio.md"))
    )

    if tipo_art in TIPOS_AUTO_APROVACAO:
        return item_role == tipo_art or item_nome == cfg.get("nome_padrao", "").lower()

    if eh_novo_artefato or ext_real in ("md", "markdown"):
        return False

    if tipo_art == "infografico":
        if ext_real in ("jpg", "jpeg") or "jpeg" in item_mime or "jpg" in item_mime or "sketchnote" in item_nome:
            return False
        return ext_real == "png" or item_mime == "image/png"

    if tipo_art == "slides":
        eh_pdf = ext_real == "pdf" or "pdf" in item_mime
        eh_sem_ocr = item.get("temOCR") is False or str(item.get("statusOCR") or "").lower() == "sem_ocr"
        return eh_pdf and eh_sem_ocr

    if tipo_art == "video":
        return ext_real in ("mp4", "mov", "webm") or item_mime.startswith("video/")

    if tipo_art == "audio":
        return ext_real in ("m4a", "mp3", "wav", "aac") or item_mime.startswith("audio/")

    return False


_DB_WRITE_LOCK = threading.RLock()


def registrar_artefato_no_db(
    job: Dict[str, Any],
    caminho_arquivo_final: Path,
    drive_file_id: str = "",
    conteudo_path: Optional[Path] = None
) -> bool:
    """
    Atualiza o `db.json` (e Firebase) inserindo ou substituindo o artefato aprovado
    (ou auto-aprovado no caso de flashcards.md, quiz.md, mapa-mental.json, relatorio.md)
    dentro dos filhos/arquivos da aula correspondente.
    Protegido por `_DB_WRITE_LOCK` para evitar race condition em conclusões paralelas.
    """
    with _DB_WRITE_LOCK:
        return _registrar_artefato_no_db_interno(
            job,
            caminho_arquivo_final,
            drive_file_id=drive_file_id,
            conteudo_path=conteudo_path
        )


def _registrar_artefato_no_db_interno(
    job: Dict[str, Any],
    caminho_arquivo_final: Path,
    drive_file_id: str = "",
    conteudo_path: Optional[Path] = None
) -> bool:
    db_data = carregar_db_local()
    if not db_data:
        return False

    ctx = localizar_aula_no_db(
        db_data,
        materia_id=job.get("materia_id", ""),
        aula_id=job.get("aula_id", ""),
        pasta_aula=job.get("pasta_aula", ""),
        notebook_url=job.get("notebook_url", "")
    )
    if not ctx:
        return False

    aula_node = ctx["aula_node"]
    tipo_art = job.get("tipo_artefato", "")
    cfg = TIPOS_ARTEFATOS_CONFIG.get(tipo_art, {})
    nome_arq = caminho_arquivo_final.name
    pasta_aula_rel = str(aula_node.get("local") or job.get("pasta_aula") or "").replace("\\", "/").strip("/")
    local_rel = f"{pasta_aula_rel}/{nome_arq}" if pasta_aula_rel else nome_arq

    id_final = drive_file_id or f"{aula_node.get('id', 'aula')}_{tipo_art}_{int(time.time())}"
    novo_no_arq: Dict[str, Any] = {
        "nome": nome_arq,
        "tipo": cfg.get("extensao", "").lstrip(".") or "arquivo",
        "id": id_final,
        "mimeType": cfg.get("mime_type", "application/octet-stream"),
        "local": local_rel
    }
    if drive_file_id:
        novo_no_arq["driveId"] = drive_file_id
        url_prev = montar_url_preview_drive(drive_file_id, tipo_art)
        if url_prev:
            novo_no_arq["url"] = url_prev

    fonte_leitura = conteudo_path if (conteudo_path and conteudo_path.exists()) else caminho_arquivo_final
    if tipo_art == "slides":
        novo_no_arq["temOCR"] = False
        novo_no_arq["statusOCR"] = "sem_ocr"
    elif tipo_art == "mindmap":
        novo_no_arq["artifactRole"] = "mindmap"
        try:
            novo_no_arq["conteudoJson"] = json.loads(fonte_leitura.read_text(encoding="utf-8"))
        except Exception:
            pass
    elif tipo_art in ("flashcards", "quiz", "relatorio"):
        novo_no_arq["artifactRole"] = tipo_art
        try:
            texto_lido = fonte_leitura.read_text(encoding="utf-8")
            if tipo_art == "flashcards":
                texto_lido = limpar_flashcards_markdown_notebooklm(texto_lido)
            novo_no_arq["conteudoTexto"] = texto_lido
        except Exception:
            pass

    lista_chave = "filhos" if "filhos" in aula_node else "arquivos"
    if lista_chave not in aula_node or not isinstance(aula_node[lista_chave], list):
        aula_node[lista_chave] = []

    filhos: List[Dict[str, Any]] = aula_node[lista_chave]

    # Se for regeração ou arquivo de mesmo papel/nome, substitui o existente
    substituiu = False
    url_antiga_norm = str(job.get("url_antiga") or "").replace("\\", "/").strip().lower()

    for idx, item in enumerate(filhos):
        if not isinstance(item, dict):
            continue
        item_nome = str(item.get("nome") or "").strip().lower()
        item_local = str(item.get("local") or "").replace("\\", "/").strip().lower()
        item_drive_id = str(item.get("driveId") or item.get("id") or "").strip()

        mesmo_tipo = _item_corresponde_ao_tipo_studio(item, tipo_art)
        mesmo_caminho_antigo = bool(
            url_antiga_norm
            and (
                item_local == url_antiga_norm
                or (item_nome and url_antiga_norm.endswith(f"/{item_nome}"))
                or (len(item_drive_id) >= 12 and item_drive_id.lower() in url_antiga_norm)
            )
            and (tipo_art != "infografico" or _item_corresponde_ao_tipo_studio(item, "infografico"))
        )
        mesmo_nome = item_nome == nome_arq.lower()

        if mesmo_tipo or mesmo_caminho_antigo or mesmo_nome:
            if not drive_file_id:
                novo_no_arq["id"] = item.get("id") or novo_no_arq["id"]
            filhos[idx] = novo_no_arq
            substituiu = True
            break

    if not substituiu:
        filhos.append(novo_no_arq)

    # Atualiza também o objeto `artifacts` se presente no nó
    if tipo_art in TIPOS_AUTO_APROVACAO:
        if "artifacts" not in aula_node or not isinstance(aula_node.get("artifacts"), dict):
            aula_node["artifacts"] = {}
        aula_node["artifacts"][tipo_art] = novo_no_arq
        aula_node[f"{tipo_art}Url"] = local_rel

    sem_nome = str(ctx.get("semestre_node", {}).get("nome") or "")
    mat_nome = str(ctx.get("materia_node", {}).get("nome") or "")
    mat_limpo = re.sub(r"^[^\w\s]+\s*", "", mat_nome).strip() or mat_nome
    aula_nome_ctx = str(aula_node.get("nome") or "")
    aula_slug_ctx = slugify_py(f"{sem_nome}-{mat_limpo}-{aula_nome_ctx}") if (sem_nome and mat_limpo and aula_nome_ctx) else ""
    aula_chave_fb = str(aula_node.get("conteudoId") or aula_slug_ctx or job.get("aula_id") or "")

    return salvar_db_local_e_nuvem(
        db_data,
        aula_id_modificada=aula_chave_fb,
        aula_node_modificada=aula_node
    )


# ==============================================================================
# 🤖 INTEGRAÇÃO COM `notebooklm-py` (FONTES E GERAÇÃO DE ARTEFATOS)
# ==============================================================================
class QuotaExceededError(Exception):
    """Exceção disparada quando o Google NotebookLM informa limite de cota/rate-limit."""
    pass


def _texto_indica_cota(texto: str) -> bool:
    msg = str(texto or "").lower()
    termos_cota = (
        "quota",
        "429",
        "resource_exhausted",
        "resourceexhausted",
        "rate limit",
        "ratelimit",
        "too many requests",
        "daily limit",
        "limit exceeded",
        "credit",
        "cota",
        "limite de geração"
    )
    return any(t in msg for t in termos_cota)


def eh_erro_de_cota(exc: Exception) -> bool:
    """Detecta se uma exceção do `notebooklm-py` / RPC do Google é limite de cota."""
    if isinstance(exc, QuotaExceededError):
        return True
    try:
        from notebooklm import AuthError, AuthExtractionError, NotebookNotFoundError, RateLimitError  # type: ignore
        if isinstance(exc, (AuthError, AuthExtractionError, NotebookNotFoundError)):
            return False
        if isinstance(exc, RateLimitError):
            return True
    except Exception:
        pass
    if isinstance(exc, (FileNotFoundError, ValueError)):
        return False
    return _texto_indica_cota(f"{type(exc).__name__}: {str(exc)}")


def eh_erro_de_autenticacao_notebooklm(exc: Exception) -> bool:
    """Detecta se uma exceção do `notebooklm-py` indica sessão/cookies expirados."""
    try:
        from notebooklm import AuthError, AuthExtractionError  # type: ignore
        if isinstance(exc, (AuthError, AuthExtractionError)):
            return True
    except Exception:
        pass
    msg = f"{type(exc).__name__}: {str(exc)}".lower()
    termos_auth = (
        "authentication expired",
        "signed-out page",
        "redirected to https://accounts.google.com",
        "sessão do notebooklm não autenticada",
        "notebooklm login",
        "autherror",
        "authextractionerror",
        "not authenticated",
    )
    return any(t in msg for t in termos_auth)


def verificar_sessao_notebooklm() -> Dict[str, Any]:
    """Verifica se `notebooklm-py` está instalado e se `storage_state.json` existe."""
    try:
        from notebooklm import paths as nlm_paths  # type: ignore
        storage_path = nlm_paths.get_storage_path()
        env_auth = bool(os.environ.get("NOTEBOOKLM_AUTH_JSON", "").strip())
        return {
            "instalado": True,
            "autenticado": storage_path.exists() or env_auth,
            "storage_path": str(storage_path),
            "env_auth": env_auth
        }
    except ImportError:
        return {
            "instalado": False,
            "autenticado": False,
            "storage_path": "",
            "env_auth": False
        }


def executar_relogin_notebooklm_sync(timeout_seg: int = AUTO_RELOGIN_TIMEOUT_SEGUNDOS) -> Dict[str, Any]:
    """
    Executa automaticamente `python -m notebooklm login` (ex.: `C:\\Python314\\python.exe -m notebooklm login`)
    e aguarda o navegador autenticar e salvar o novo `storage_state.json`.
    """
    python_exe = NOTEBOOKLM_PYTHON_EXE or sys.executable
    cmd = [python_exe, "-m", "notebooklm", "login"]
    cmd_str = f"{python_exe} -m notebooklm login"
    print(
        f"🔑 [Auto-Relogin] Sessão expirada! Iniciando renovação automática:\n"
        f"   👉 {cmd_str}\n"
        f"   ⏳ Aguardando navegador autenticar e salvar a sessão (timeout: {timeout_seg}s)..."
    )
    try:
        proc = subprocess.run(
            cmd,
            timeout=timeout_seg,
            stdin=subprocess.DEVNULL,
            check=False
        )
        sessao = verificar_sessao_notebooklm()
        storage_path = Path(sessao.get("storage_path") or "") if sessao.get("storage_path") else None
        arquivo_ok = bool(
            sessao.get("env_auth")
            or (storage_path and storage_path.exists() and storage_path.stat().st_size > 20)
        )
        if proc.returncode == 0 and sessao.get("autenticado") and arquivo_ok:
            print(f"✅ [Auto-Relogin] Login renovado e salvo em: {sessao.get('storage_path') or 'sessão ativa'}")
            return {
                "ok": True,
                "returncode": proc.returncode,
                "comando": cmd_str,
                "storage_path": sessao.get("storage_path", "")
            }
        erro_msg = f"Comando retornou código {proc.returncode} (autenticado={sessao.get('autenticado')})."
        print(f"⚠️ [Auto-Relogin] Falha ao renovar sessão automaticamente: {erro_msg}")
        return {
            "ok": False,
            "returncode": proc.returncode,
            "comando": cmd_str,
            "erro": erro_msg
        }
    except subprocess.TimeoutExpired:
        erro_msg = f"Tempo limite ({timeout_seg}s) esgotado aguardando '{cmd_str}' salvar a sessão."
        print(f"⚠️ [Auto-Relogin] {erro_msg}")
        return {"ok": False, "returncode": -1, "comando": cmd_str, "erro": erro_msg}
    except Exception as exc:
        erro_msg = f"Erro ao executar '{cmd_str}': {exc}"
        print(f"⚠️ [Auto-Relogin] {erro_msg}")
        return {"ok": False, "returncode": -1, "comando": cmd_str, "erro": erro_msg}


async def listar_fontes_notebooklm_async(notebook_url: str, materia_id: str = "", aula_id: str = "") -> Dict[str, Any]:
    """
    Consulta o caderno no NotebookLM via `notebooklm-py` para listar as fontes
    cadastradas e cruza com os arquivos da aula no `db.json`.
    """
    nb_id = extrair_notebook_id(notebook_url)
    db_data = carregar_db_local()
    ctx = localizar_aula_no_db(db_data, materia_id=materia_id, aula_id=aula_id, notebook_url=notebook_url) if db_data else None

    arquivos_esperados_db: List[Dict[str, Any]] = []
    if ctx and ctx.get("aula_node"):
        aula_node = ctx["aula_node"]
        for arq in (aula_node.get("filhos") or aula_node.get("arquivos") or []):
            if isinstance(arq, dict) and arq.get("nome"):
                arquivos_esperados_db.append({
                    "nome": arq.get("nome"),
                    "tipo": arq.get("tipo", ""),
                    "local": arq.get("local", "")
                })

    fontes_remotas: List[Dict[str, Any]] = []
    modo_conexao = "notebooklm-py"
    aviso_sdk = ""

    if not nb_id:
        return {
            "ok": False,
            "erro": "URL do NotebookLM inválida ou ausente nesta aula.",
            "notebook_id": "",
            "notebook_url": notebook_url,
            "fontes": [],
            "arquivos_aula_db": arquivos_esperados_db,
            "diagnostico": {
                "total_fontes_notebook": 0,
                "total_arquivos_aula": len(arquivos_esperados_db),
                "faltando_no_notebook": [a["nome"] for a in arquivos_esperados_db],
                "possui_erro_fontes": True
            }
        }

    try:
        from notebooklm import NotebookLMClient  # type: ignore
        async with await NotebookLMClient.from_storage() as client:
            if hasattr(client, "sources") and hasattr(client.sources, "list"):
                raw_sources = await client.sources.list(nb_id)
            elif hasattr(client, "get_notebook"):
                nb_obj = await client.get_notebook(nb_id)
                raw_sources = getattr(nb_obj, "sources", [])
            else:
                raw_sources = []

            for src in (raw_sources or []):
                fontes_remotas.append({
                    "id": str(getattr(src, "id", getattr(src, "source_id", "")) or ""),
                    "titulo": str(getattr(src, "title", getattr(src, "name", "Fonte")) or "Fonte"),
                    "tipo": str(getattr(src, "source_type", getattr(src, "type", "documento")) or "documento"),
                    "status": str(getattr(src, "status", "pronto") or "pronto")
                })
    except ImportError:
        modo_conexao = "fallback_offline"
        aviso_sdk = (
            "Pacote 'notebooklm-py' ainda não instalado no ambiente Python local. "
            "Instale com: pip install \"notebooklm-py[browser]\" && notebooklm login"
        )
        # Se a aula já tiver relatório salvo no db.json, retorna-o
        if ctx and isinstance(ctx["aula_node"].get("relatorioFontesNotebook"), list):
            fontes_remotas = ctx["aula_node"]["relatorioFontesNotebook"]
    except Exception as e:
        modo_conexao = "erro_conexao"
        aviso_sdk = f"Aviso ao consultar NotebookLM ({type(e).__name__}): {str(e)}"
        if ctx and isinstance(ctx["aula_node"].get("relatorioFontesNotebook"), list):
            fontes_remotas = ctx["aula_node"]["relatorioFontesNotebook"]

    nomes_no_notebook = {str(f.get("titulo", "")).strip().lower() for f in fontes_remotas}
    faltando = [
        a["nome"] for a in arquivos_esperados_db
        if str(a["nome"]).strip().lower() not in nomes_no_notebook
        and not str(a["nome"]).lower().endswith(("mapa-mental.json", "flashcards.md", "quiz.md", "relatorio.md"))
    ]

    return {
        "ok": True,
        "modo_conexao": modo_conexao,
        "aviso_sdk": aviso_sdk,
        "notebook_id": nb_id,
        "notebook_url": notebook_url,
        "materia_id": materia_id,
        "aula_id": aula_id,
        "fontes": fontes_remotas,
        "arquivos_aula_db": arquivos_esperados_db,
        "diagnostico": {
            "total_fontes_notebook": len(fontes_remotas),
            "total_arquivos_aula": len(arquivos_esperados_db),
            "faltando_no_notebook": faltando,
            "possui_erro_fontes": len(fontes_remotas) == 0 or len(faltando) > 0
        },
        "consultado_em": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    }


async def adicionar_fonte_notebooklm_async(
    notebook_url: str,
    tipo_fonte: str,
    valor: str,
    titulo: str = ""
) -> Dict[str, Any]:
    """Adiciona uma fonte (URL, arquivo local ou texto) ao caderno via `notebooklm-py`."""
    nb_id = extrair_notebook_id(notebook_url)
    if not nb_id:
        return {"ok": False, "erro": "ID do caderno NotebookLM inválido."}

    try:
        from notebooklm import NotebookLMClient  # type: ignore
        async with await NotebookLMClient.from_storage() as client:
            if tipo_fonte == "url":
                res = await client.sources.add_url(nb_id, valor, wait=True)
            elif tipo_fonte == "arquivo":
                caminho_arq = Path(valor)
                if not caminho_arq.is_absolute():
                    cand_drive = BASE_DRIVE_DIR / valor.replace("/", os.sep)
                    if cand_drive.exists():
                        caminho_arq = cand_drive
                res = await client.sources.add_file(nb_id, str(caminho_arq))
            else:
                if hasattr(client.sources, "add_text"):
                    res = await client.sources.add_text(nb_id, title=titulo or "Nota da Aula", content=valor)
                else:
                    temp_md = STAGING_DIR / f"fonte_temp_{int(time.time())}.md"
                    temp_md.write_text(valor, encoding="utf-8")
                    res = await client.sources.add_file(nb_id, str(temp_md))

            return {
                "ok": True,
                "fonte_id": str(getattr(res, "id", getattr(res, "source_id", f"src_{int(time.time())}"))),
                "titulo": titulo or valor
            }
    except ImportError:
        return {
            "ok": True,
            "modo_simulado": True,
            "fonte_id": f"src_local_{int(time.time())}",
            "titulo": titulo or valor,
            "aviso": "Fonte registrada localmente (instale notebooklm-py para envio direto ao Google NotebookLM)."
        }
    except Exception as e:
        return {"ok": False, "erro": str(e)}


async def remover_fonte_notebooklm_async(notebook_url: str, fonte_id: str) -> Dict[str, Any]:
    """Remove uma fonte do caderno no Google NotebookLM via `notebooklm-py`."""
    nb_id = extrair_notebook_id(notebook_url)
    if not nb_id or not fonte_id:
        return {"ok": False, "erro": "notebook_url e fonte_id são obrigatórios."}

    try:
        from notebooklm import NotebookLMClient  # type: ignore
        async with await NotebookLMClient.from_storage() as client:
            if hasattr(client.sources, "delete"):
                await client.sources.delete(nb_id, fonte_id)
            elif hasattr(client.sources, "remove"):
                await client.sources.remove(nb_id, fonte_id)
            return {"ok": True, "removido": fonte_id}
    except ImportError:
        return {"ok": True, "removido": fonte_id, "modo_simulado": True}
    except Exception as e:
        return {"ok": False, "erro": str(e)}


def _gerar_conteudo_fallback_estruturado(job: Dict[str, Any], destino_path: Path) -> None:
    """
    Quando `notebooklm-py` não está autenticado/instalado na máquina de teste,
    gera o artefato de staging/destino devidamente estruturado com base no resumo
    Markdown real da aula no `db.json` para que o fluxo ponta a ponta funcione sem quebras.
    """
    tipo = job.get("tipo_artefato", "")
    aula_nome = job.get("aula_nome") or job.get("aula_id") or "Aula"
    materia_nome = job.get("materia_nome") or job.get("materia_id") or "Matéria"
    destino_path.parent.mkdir(parents=True, exist_ok=True)

    if tipo == "mindmap":
        arvore = {
            "name": f"{aula_nome} ({materia_nome})",
            "children": [
                {
                    "name": "1. Fundamentos & Arquitetura",
                    "children": [
                        {"name": "Definição Formal & Modelo Mental"},
                        {"name": "Princípios de Funcionamento"}
                    ]
                },
                {
                    "name": "2. Implementação & Casos Reais",
                    "children": [
                        {"name": "Aplicação Prática no Mercado"},
                        {"name": "Análise de Desempenho & Escala"}
                    ]
                },
                {
                    "name": "3. Trade-offs & Pontos de Atenção",
                    "children": [
                        {"name": "Pitfalls Comuns"},
                        {"name": "Boas Práticas (Clean Code)"}
                    ]
                }
            ]
        }
        destino_path.write_text(json.dumps(arvore, ensure_ascii=False, indent=2), encoding="utf-8")

    elif tipo == "flashcards":
        md = (
            f"# Flashcards — {aula_nome}\n\n"
            f"## Card 1\n\n"
            f"**Q:** Qual é o problema arquitetural central abordado em {aula_nome} de {materia_nome}?\n\n"
            f"**A:** A estruturação eficiente de modelos computacionais garantindo escalabilidade, clareza semântica e baixo acoplamento.\n\n"
            f"---\n\n"
            f"## Card 2\n\n"
            f"**Q:** Qual é a principal armadilha (Pitfall) que deve ser evitada ao aplicar os conceitos de {aula_nome}?\n\n"
            f"**A:** Ignorar as restrições de complexidade assintótica e acoplamento de estado em cenários de produção.\n\n"
            f"---\n"
        )
        destino_path.write_text(md, encoding="utf-8")

    elif tipo == "quiz":
        md = (
            f"# Quiz Tático — {aula_nome}\n\n"
            f"## Question 1\n"
            f"Ao aplicar os conceitos de {aula_nome} ({materia_nome}) em um sistema de produção real, qual decisão arquitetural preserva melhor a manutenibilidade e o desempenho?\n\n"
            f"- [ ] Acoplar diretamente todas as camadas sem isolamento de contrato.\n"
            f"- [x] Isolar responsabilidades aplicando os princípios fundamentais da aula e validando limites de operação.\n"
            f"- [ ] Descartar verificações de estado para reduzir linhas de código.\n"
            f"- [ ] Utilizar variáveis globais mutáveis compartilhadas sem sincronização.\n\n"
            f"**Hint:** Lembre-se do princípio de isolamento de responsabilidades e prevenção de efeitos colaterais discutido na aula.\n"
        )
        destino_path.write_text(md, encoding="utf-8")

    elif tipo == "relatorio":
        md = (
            f"# Relatório Técnico — {aula_nome} ({materia_nome})\n\n"
            f"## Executive Summary\n\n"
            f"Este relatório consolida a arquitetura técnica e os modelos mentais de **{aula_nome}** na disciplina **{materia_nome}**, "
            f"destacando os mecanismos fundamentais, trade-offs operacionais e diretrizes práticas de engenharia.\n\n"
            f"## Pilares Arquiteturais\n\n"
            f"1. **Modelagem de Primeira Ordem:** Compreensão do problema antes da escolha da ferramenta.\n"
            f"2. **Eficiência e Escalabilidade:** Controle rigoroso do consumo de recursos.\n"
            f"3. **Resiliência:** Prevenção ativa contra falhas silenciosas.\n"
        )
        destino_path.write_text(md, encoding="utf-8")

    elif tipo == "infografico":
        # PNG 1x1 dark-mode válido mínimo para preview sem quebrar <img>
        import base64
        png_b64 = (
            "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk"
            "+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="
        )
        destino_path.write_bytes(base64.b64decode(png_b64))

    elif tipo == "slides":
        # PDF válido mínimo sem camada OCR para preview em <iframe>
        pdf_bytes = (
            b"%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n"
            b"2 0 obj<</Type/Pages/Count 1/Kids[3 0 R]>>endobj\n"
            b"3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]>>endobj\n"
            b"xref\n0 4\n0000000000 65535 f \n0000000009 00000 n \n"
            b"0000000052 00000 n \n0000000101 00000 n \n"
            b"trailer<</Size 4/Root 1 0 R>>\nstartxref\n164\n%%EOF\n"
        )
        destino_path.write_bytes(pdf_bytes)

    else:
        # Áudio (.m4a) ou Vídeo (.mp4) container mínimo
        destino_path.write_bytes(b"\x00\x00\x00\x18ftypmp42\x00\x00\x00\x00mp42isom")


async def _aguardar_task_notebooklm(
    artifacts_api: Any,
    nb_id: str,
    task: Any,
    timeout_seg: float,
    label: str
) -> None:
    """Valida o status inicial e aguarda a conclusão real da geração no NotebookLM."""
    if getattr(task, "is_rate_limited", False):
        raise QuotaExceededError(getattr(task, "error", None) or f"Cota/rate-limit atingido ao gerar {label}.")
    if getattr(task, "is_failed", False):
        err_msg = str(getattr(task, "error", None) or getattr(task, "error_code", None) or "erro desconhecido")
        if _texto_indica_cota(err_msg):
            raise QuotaExceededError(err_msg)
        raise RuntimeError(f"NotebookLM falhou ao iniciar {label}: {err_msg}")

    task_id = getattr(task, "task_id", None)
    if not task_id:
        raise RuntimeError(f"NotebookLM não retornou task_id para {label}.")

    print(f"⏳ [NotebookLM] Aguardando geração de {label} (task={task_id})...")
    status_final = await artifacts_api.wait_for_completion(nb_id, task_id, timeout=timeout_seg)
    if getattr(status_final, "is_rate_limited", False):
        raise QuotaExceededError(getattr(status_final, "error", None) or f"Cota atingida durante {label}.")
    if getattr(status_final, "is_failed", False) or not getattr(status_final, "is_complete", False):
        err_msg = str(getattr(status_final, "error", None) or getattr(status_final, "error_code", None) or "timeout/falha")
        if _texto_indica_cota(err_msg):
            raise QuotaExceededError(err_msg)
        raise RuntimeError(f"Geração de {label} não concluída no NotebookLM: {err_msg}")


_stagger_lock_loop: Optional[asyncio.Lock] = None
_stagger_lock_loop_ref: Optional[asyncio.AbstractEventLoop] = None
_ultimo_disparo_notebooklm_ts: float = 0.0


async def _aguardar_stagger_disparo_notebooklm(job: Dict[str, Any]) -> None:
    """
    Escala os disparos `generate_*` com um intervalo seguro (padrão 3s) entre
    chamadas iniciais RPC, liberando o lock antes da espera longa de renderização.
    """
    global _stagger_lock_loop, _stagger_lock_loop_ref, _ultimo_disparo_notebooklm_ts
    if job.get("simular_geracao_local") is True or INTERVALO_STAGGER_DISPARO_SEGUNDOS <= 0:
        return

    loop_atual = asyncio.get_running_loop()
    if _stagger_lock_loop is None or _stagger_lock_loop_ref is not loop_atual:
        _stagger_lock_loop = asyncio.Lock()
        _stagger_lock_loop_ref = loop_atual

    async with _stagger_lock_loop:
        if _ultimo_disparo_notebooklm_ts > 0:
            decorrido = time.monotonic() - _ultimo_disparo_notebooklm_ts
            restante = INTERVALO_STAGGER_DISPARO_SEGUNDOS - decorrido
            if restante > 0:
                await asyncio.sleep(restante)
        _ultimo_disparo_notebooklm_ts = time.monotonic()


async def executar_geracao_notebooklm_async(job: Dict[str, Any], destino_path: Path) -> None:
    """
    Aciona o `notebooklm-py` aplicando toda a configuração avançada específica do
    artefato (`config_geracao`) e o prompt de `prompts.json` adaptado para a aula.
    NUNCA gera arquivo fake em produção; falhas reais interrompem o job com erro claro.
    """
    if job.get("simular_cota_excedida"):
        raise QuotaExceededError("Limite de cota/créditos do Google NotebookLM atingido (429 ResourceExhausted).")

    nb_id = extrair_notebook_id(job.get("notebook_url", ""))
    tipo = job.get("tipo_artefato", "")
    cfg_atual = job.get("config_geracao")
    if not isinstance(cfg_atual, dict) or "prompt_final" not in cfg_atual:
        config_geracao = construir_config_geracao_artefato(job)
    else:
        config_geracao = cfg_atual
    job["config_geracao"] = config_geracao
    prompt_fixo = str(config_geracao.get("prompt_final") or PROMPTS_FIXOS.get(tipo, ""))
    destino_path.parent.mkdir(parents=True, exist_ok=True)

    # Modo isolado exclusivo para testes unitários offline
    if job.get("simular_geracao_local") is True:
        await asyncio.sleep(0.02)
        _gerar_conteudo_fallback_estruturado(job, destino_path)
        return

    if not nb_id:
        raise ValueError(f"URL do NotebookLM ausente ou inválida para a aula '{job.get('aula_nome') or job.get('aula_id')}'.")

    sessao = verificar_sessao_notebooklm()
    if not sessao["instalado"]:
        raise RuntimeError("Pacote 'notebooklm-py' não instalado no ambiente Python atual.")
    if not sessao["autenticado"]:
        raise RuntimeError(
            f"Sessão do NotebookLM não autenticada ({sessao['storage_path']}). "
            f"Execute '{sys.executable} -m notebooklm login' no terminal para entrar na sua conta Google."
        )

    from notebooklm import (  # type: ignore
        NotebookLMClient,
        AudioFormat,
        VideoFormat,
        VideoStyle,
        SlideDeckFormat,
        SlideDeckLength,
        InfographicOrientation,
        InfographicDetail,
        InfographicStyle,
        QuizQuantity,
        QuizDifficulty,
        ReportFormat,
    )

    print(
        f"🚀 [NotebookLM] Gerando '{tipo}' para '{job.get('materia_nome')}' / "
        f"'{job.get('aula_nome')}' (notebook={nb_id})..."
    )

    await _aguardar_stagger_disparo_notebooklm(job)

    async with await NotebookLMClient.from_storage() as client:
        artifacts_api = client.artifacts

        if tipo == "audio":
            task = await artifacts_api.generate_audio(
                nb_id,
                language="pt",
                audio_format=AudioFormat.DEEP_DIVE,
                instructions=config_geracao.get("foco_apresentadores") or prompt_fixo
            )
            await _aguardar_task_notebooklm(artifacts_api, nb_id, task, 900.0, "Áudio")
            await artifacts_api.download_audio(nb_id, str(destino_path), artifact_id=task.task_id)

        elif tipo == "slides":
            task = await artifacts_api.generate_slide_deck(
                nb_id,
                language="pt",
                slide_format=SlideDeckFormat.DETAILED_DECK,
                slide_length=SlideDeckLength.DEFAULT,
                instructions=config_geracao.get("descricao_slides") or prompt_fixo
            )
            await _aguardar_task_notebooklm(artifacts_api, nb_id, task, 900.0, "Slides")
            await artifacts_api.download_slide_deck(
                nb_id, str(destino_path), output_format="pdf", artifact_id=task.task_id
            )

        elif tipo == "video":
            style_prompt = str(config_geracao.get("estilo_visual_personalizado") or "").strip()
            assunto_prompt = str(config_geracao.get("assunto_personalizado") or prompt_fixo).strip()
            task = await artifacts_api.generate_video(
                nb_id,
                language="pt",
                video_format=VideoFormat.EXPLAINER,
                video_style=VideoStyle.CUSTOM,
                style_prompt=style_prompt or None,
                instructions=assunto_prompt or None
            )
            await _aguardar_task_notebooklm(artifacts_api, nb_id, task, 900.0, "Vídeo")
            await artifacts_api.download_video(nb_id, str(destino_path), artifact_id=task.task_id)

        elif tipo == "infografico":
            desc_info = str(config_geracao.get("descricao_infografico") or prompt_fixo).strip()
            task = await artifacts_api.generate_infographic(
                nb_id,
                language="pt",
                orientation=InfographicOrientation.LANDSCAPE,
                style=InfographicStyle.AUTO_SELECT,
                detail_level=InfographicDetail.STANDARD,
                instructions=desc_info or None
            )
            await _aguardar_task_notebooklm(artifacts_api, nb_id, task, 600.0, "Infográfico")
            await artifacts_api.download_infographic(nb_id, str(destino_path), artifact_id=task.task_id)

        elif tipo == "flashcards":
            tema_fc = str(config_geracao.get("tema") or prompt_fixo).strip()
            if config_geracao.get("incluir_imagens", True):
                tema_fc = f"{tema_fc}\n\n[Configuração]: Incluir imagens/referências visuais quando aplicável."
            task = await artifacts_api.generate_flashcards(
                nb_id,
                quantity=QuizQuantity.MORE,
                difficulty=QuizDifficulty.MEDIUM,
                instructions=tema_fc or None
            )
            await _aguardar_task_notebooklm(artifacts_api, nb_id, task, 600.0, "Flashcards")
            await artifacts_api.download_flashcards(
                nb_id, str(destino_path), output_format="markdown", artifact_id=task.task_id
            )
            if destino_path.exists():
                fc_bruto = destino_path.read_text(encoding="utf-8", errors="replace")
                fc_limpo = limpar_flashcards_markdown_notebooklm(fc_bruto)
                if fc_limpo != fc_bruto:
                    destino_path.write_text(fc_limpo, encoding="utf-8")

        elif tipo == "quiz":
            tipos_p = ", ".join(config_geracao.get("tipos_perguntas") or [])
            tema_qz = str(config_geracao.get("tema") or prompt_fixo).strip()
            prefix_opts: List[str] = []
            if tipos_p:
                prefix_opts.append(f"Tipos de perguntas permitidos: {tipos_p}")
            if config_geracao.get("incluir_imagens", True):
                prefix_opts.append("Incluir imagens quando pertinente")
            instrucoes_quiz = f"[{' | '.join(prefix_opts)}]\n{tema_qz}".strip() if prefix_opts else tema_qz
            task = await artifacts_api.generate_quiz(
                nb_id,
                quantity=QuizQuantity.MORE,
                difficulty=QuizDifficulty.MEDIUM,
                instructions=instrucoes_quiz or None
            )
            await _aguardar_task_notebooklm(artifacts_api, nb_id, task, 600.0, "Teste/Quiz")
            await artifacts_api.download_quiz(
                nb_id, str(destino_path), output_format="markdown", artifact_id=task.task_id
            )

        elif tipo == "relatorio":
            desc_rel = str(config_geracao.get("descricao_relatorio") or prompt_fixo).strip()
            task = await artifacts_api.generate_report(
                nb_id,
                report_format=ReportFormat.CUSTOM,
                language="pt",
                custom_prompt=desc_rel or None
            )
            await _aguardar_task_notebooklm(artifacts_api, nb_id, task, 600.0, "Relatório")
            await artifacts_api.download_report(
                nb_id, str(destino_path), artifact_id=task.task_id
            )

        elif tipo == "mindmap":
            mm_res = await artifacts_api.generate_mind_map(nb_id, language="pt")
            mm_data = getattr(mm_res, "mind_map", None)
            if isinstance(mm_data, (dict, list)) and mm_data:
                destino_path.write_text(json.dumps(mm_data, ensure_ascii=False, indent=2), encoding="utf-8")
            elif getattr(mm_res, "note_id", None):
                await artifacts_api.download_mind_map(
                    nb_id, str(destino_path), artifact_id=mm_res.note_id
                )
            else:
                raise RuntimeError("NotebookLM não retornou estrutura válida de Mapa Mental.")
        else:
            raise ValueError(f"Tipo de artefato não suportado para geração: '{tipo}'")

    if not destino_path.exists() or destino_path.stat().st_size < 16:
        raise RuntimeError(f"Download do artefato '{tipo}' resultou em arquivo ausente ou vazio ({destino_path}).")

    print(f"📦 [NotebookLM] Download concluído: {destino_path.name} ({destino_path.stat().st_size:,} bytes)")


# ==============================================================================
# 📦 GERENCIADOR DE FILA PERSISTENTE ONLINE (Firebase `/fila_studio` + `fila_studio.json`)
# ==============================================================================
def compactar_job_para_firebase(job: Dict[str, Any]) -> Dict[str, Any]:
    """
    Remove prompts extensos de `config_geracao` antes de gravar o job em `/fila_studio`,
    mantendo apenas `resumo_label` (economia de ~1.6 KB por item no Firebase RTDB).
    """
    job_copy = dict(job)
    cfg_atual = job_copy.get("config_geracao")
    resumo_label = cfg_atual.get("resumo_label", "") if isinstance(cfg_atual, dict) else ""
    job_copy["config_geracao"] = {"resumo_label": str(resumo_label)}
    if not job_copy.get("admin_gate"):
        job_copy["admin_gate"] = STUDIO_ADMIN_GATE
    return job_copy


class StudioQueueManager:
    """
    Gerencia a fila persistente híbrida (Online no Firebase `/fila_studio` + cache local `fila_studio.json`),
    suportando:
    - Enfileiramento remoto com o PC principal desligado;
    - Staging no Google Drive (`_staging_studio/`);
    - Aprovação, Tentar de Novo e Cancelamento feitos 100% online (`aprovado_pendente_mover`,
      `cancelado_pendente_excluir` e `limpar_staging_anterior`) executados fisicamente no Drive
      assim que o worker inicia ou sincroniza;
    - Guardião de Cota Persistente (`aguardando_cota`) e Auto-Aprovação de não-visuais.
    """

    def __init__(self, fila_path: Path = FILA_STUDIO_PATH, staging_dir: Path = STAGING_DIR, enable_firebase: bool = True):
        self.fila_path = fila_path
        self.staging_dir = staging_dir
        self.enable_firebase = enable_firebase
        self.lock = threading.RLock()
        self._firebase_sync_lock = threading.Lock()
        self.jobs: Dict[str, Dict[str, Any]] = {}
        self.cota_status: str = "OK"  # "OK" | "Pausada"
        self.cota_pausada_em: float = 0.0
        self.ultimo_erro_cota: str = ""
        self._fila_epoch: int = 0
        self._ultimo_meta_firebase_ts: int = 0
        self._ultimo_limpo_em: int = 0
        self._ultima_checagem_firebase_ts: float = 0.0
        self._sync_inicial_firebase_ok: bool = False
        self._auth_relogin_em_andamento: bool = False
        self._ultimo_relogin_ok_ts: float = 0.0
        self._tentativas_relogin_ts: List[float] = []
        self.auto_relogin_enabled: bool = AUTO_RELOGIN_HABILITADO
        self.intervalo_sync_firebase_seg: float = float(os.environ.get("STUDIO_FIREBASE_POLL_SEC", "15.0"))
        self._carregar_do_disco()

    def _carregar_do_disco(self) -> None:
        with self.lock:
            if not self.fila_path.exists():
                self.jobs = {}
                return
            try:
                raw = json.loads(self.fila_path.read_text(encoding="utf-8"))
                if isinstance(raw, dict) and "jobs" in raw:
                    lista = raw.get("jobs", [])
                    self.cota_status = raw.get("cota_status", "OK")
                    self.cota_pausada_em = float(raw.get("cota_pausada_em", 0.0) or 0.0)
                    self.ultimo_erro_cota = str(raw.get("ultimo_erro_cota", "") or "")
                    self.jobs = {j["id"]: j for j in lista if isinstance(j, dict) and "id" in j}
                elif isinstance(raw, list):
                    self.jobs = {j["id"]: j for j in raw if isinstance(j, dict) and "id" in j}
                elif isinstance(raw, dict):
                    self.jobs = {k: v for k, v in raw.items() if isinstance(v, dict)}

                # Se o processo anterior foi encerrado enquanto um item estava `gerando`,
                # devolve-o para `na_fila` para não travar a fila.
                for j in self.jobs.values():
                    if j.get("status") == "gerando":
                        j["status"] = "na_fila"
            except Exception as e:
                print(f"⚠️ [StudioQueue] Erro ao carregar {self.fila_path.name}: {e}")
                self.jobs = {}

    def _registrar_e_publicar_meta_firebase(self) -> int:
        ts = int(time.time() * 1000)
        self._ultimo_meta_firebase_ts = ts
        return ts

    def _sync_job_firebase_async(self, job: Dict[str, Any]) -> None:
        if not self.enable_firebase:
            return
        job_copy = compactar_job_para_firebase(job)
        epoch = self._fila_epoch
        ts = self._registrar_e_publicar_meta_firebase()

        def _enviar() -> None:
            with self._firebase_sync_lock:
                if self._fila_epoch != epoch:
                    return
                firebase_put(f"fila_studio/{job_copy['id']}", job_copy)
                firebase_publicar_meta_fila(ts)

        threading.Thread(target=_enviar, daemon=True).start()

    def _sync_jobs_lote_firebase_async(self, jobs_lista: List[Dict[str, Any]]) -> None:
        if not self.enable_firebase or not jobs_lista:
            return
        if len(jobs_lista) == 1:
            self._sync_job_firebase_async(jobs_lista[0])
            return
        compactos = [compactar_job_para_firebase(j) for j in jobs_lista if j.get("id")]
        epoch = self._fila_epoch
        ts = self._registrar_e_publicar_meta_firebase()

        def _enviar_lote() -> None:
            with self._firebase_sync_lock:
                if self._fila_epoch != epoch:
                    return
                for i in range(0, len(compactos), 200):
                    if self._fila_epoch != epoch:
                        return
                    fatia = compactos[i:i + 200]
                    mapa = {j["id"]: j for j in fatia}
                    firebase_patch("fila_studio", mapa)
                if self._fila_epoch == epoch:
                    firebase_publicar_meta_fila(ts)

        threading.Thread(target=_enviar_lote, daemon=True).start()

    def _delete_job_firebase_async(self, job_id: str) -> None:
        if not self.enable_firebase:
            return
        epoch = self._fila_epoch
        ts = self._registrar_e_publicar_meta_firebase()

        def _deletar() -> None:
            with self._firebase_sync_lock:
                if self._fila_epoch != epoch:
                    return
                firebase_delete(f"fila_studio/{job_id}")
                firebase_publicar_meta_fila(ts)

        threading.Thread(target=_deletar, daemon=True).start()

    def limpar_fila(self) -> Dict[str, Any]:
        """
        Zera 100% dos jobs da fila local, do disco, das tarefas em andamento e do Firebase (`/fila_studio`).
        Usa `GET ?shallow=true` + `PATCH {id: null}` em lotes (compatível com as regras por `$job_id`)
        e verifica no banco que restaram exatamente 0 itens antes de retornar.
        """
        with self.lock:
            ids_locais = list(self.jobs.keys())
            removidos = len(ids_locais)
            self._fila_epoch += 1
            self.jobs.clear()
            self.cota_status = "OK"
            self.cota_pausada_em = 0.0
            self.ultimo_erro_cota = ""
            self._tentativas_relogin_ts.clear()
            self.salvar_no_disco()

        _cancelar_tasks_ativas_worker()

        res_fb: Dict[str, Any] = {"ok": True, "removidos": 0, "restantes": 0}
        if self.enable_firebase:
            with self._firebase_sync_lock:
                res_fb = firebase_limpar_colecao("fila_studio", chaves_extras=ids_locais)
                ts = self._registrar_e_publicar_meta_firebase()
                self._ultimo_limpo_em = ts
                firebase_publicar_meta_fila(ts, acao="limpar_fila", limpo_em=ts)
            print(
                f"🗑️ [StudioWorker] Fila limpa! Local: {removidos} | "
                f"Firebase (/fila_studio): {res_fb['removidos']} removido(s), "
                f"{res_fb['restantes']} restante(s) (ok={res_fb['ok']})."
            )

        return {
            "ok": True,
            "removidos": removidos,
            "removidos_firebase": res_fb.get("removidos", 0),
            "restantes_firebase": res_fb.get("restantes", 0),
            "firebase_limpo": bool(res_fb.get("ok", False)),
            "contadores": self.obter_contadores()
        }

    def salvar_no_disco(self) -> None:
        with self.lock:
            payload = {
                "cota_status": self.cota_status,
                "cota_pausada_em": self.cota_pausada_em,
                "ultimo_erro_cota": self.ultimo_erro_cota,
                "atualizado_em": int(time.time() * 1000),
                "jobs": list(self.jobs.values())
            }
            temp_path = self.fila_path.with_suffix(".tmp")
            temp_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
            temp_path.replace(self.fila_path)

    def _remover_arquivo_staging_job(self, job: Dict[str, Any]) -> None:
        """Remove o arquivo de staging tanto no Google Drive (API v3 / DriveFS) quanto no `staging/` local."""
        drive_id = str(job.get("staging_drive_id") or "").strip()
        if (
            drive_id
            and self.enable_firebase
            and self.staging_dir == STAGING_DIR
            and not job.get("simular_geracao_local")
        ):
            if deletar_arquivo_drive(drive_id):
                print(f"🗑️ [Staging Drive] Arquivo '{drive_id}' excluído do Google Drive.")

        staging_rel = str(job.get("caminho_staging") or "")
        nome_arq = Path(staging_rel).name if staging_rel else ""
        candidatos: List[Path] = []
        if staging_rel:
            candidatos.append(SCRIPT_DIR / staging_rel.replace("/", os.sep))
            candidatos.append(self.staging_dir / nome_arq)
        if job.get("staging_drive_path"):
            candidatos.append(Path(str(job["staging_drive_path"])))
        if nome_arq and DRIVE_STAGING_DIR:
            candidatos.append(DRIVE_STAGING_DIR / nome_arq)

        for cand in candidatos:
            try:
                if cand.exists() and cand.is_file():
                    cand.unlink()
            except Exception:
                pass

    def sincronizar_com_firebase(self, forcar: bool = False) -> int:
        """
        Puxa os jobs remotos de `/fila_studio` no Firebase somente quando necessário:
        - Respeita cooldown de `self.intervalo_sync_firebase_seg` (15s por padrão) se `forcar=False`.
        - Consulta antes o nó leve `/fila_studio_meta` (~80 bytes); se `atualizado_em` não mudou
          desde a última checagem e já fez sync inicial, retorna 0 sem baixar `/fila_studio`.
        """
        if not self.enable_firebase:
            return 0

        agora_mono = time.monotonic()
        if (
            not forcar
            and self._sync_inicial_firebase_ok
            and self._ultima_checagem_firebase_ts > 0
            and (agora_mono - self._ultima_checagem_firebase_ts) < self.intervalo_sync_firebase_seg
        ):
            return 0
        self._ultima_checagem_firebase_ts = agora_mono

        meta_remoto = firebase_get("fila_studio_meta")
        meta_ts_remoto: Optional[int] = None
        meta_acao_remoto: str = ""
        meta_limpo_em: int = 0
        if isinstance(meta_remoto, dict):
            if "atualizado_em" in meta_remoto:
                try:
                    meta_ts_remoto = int(meta_remoto.get("atualizado_em") or 0)
                except (TypeError, ValueError):
                    meta_ts_remoto = None
            meta_acao_remoto = str(meta_remoto.get("acao") or "").strip().lower()
            try:
                meta_limpo_em = int(meta_remoto.get("limpo_em") or 0)
            except (TypeError, ValueError):
                meta_limpo_em = 0

        if (
            not forcar
            and self._sync_inicial_firebase_ok
            and meta_ts_remoto is not None
            and meta_ts_remoto == self._ultimo_meta_firebase_ts
        ):
            return 0

        remoto = firebase_get("fila_studio")
        self._sync_inicial_firebase_ok = True
        if meta_ts_remoto is not None:
            self._ultimo_meta_firebase_ts = meta_ts_remoto
        if not isinstance(remoto, dict):
            limpeza_remota_nova = (
                (meta_limpo_em > 0 and meta_limpo_em > self._ultimo_limpo_em)
                or (meta_acao_remoto == "limpar_fila" and meta_ts_remoto is not None and meta_ts_remoto > self._ultimo_limpo_em)
            )
            if limpeza_remota_nova:
                with self.lock:
                    qtd_limpa = len(self.jobs)
                    self._ultimo_limpo_em = max(meta_limpo_em, meta_ts_remoto or 0)
                    if qtd_limpa > 0 or self.cota_status == "Pausada":
                        self._fila_epoch += 1
                        self.jobs.clear()
                        self.cota_status = "OK"
                        self.cota_pausada_em = 0.0
                        self.ultimo_erro_cota = ""
                        self.salvar_no_disco()
                if qtd_limpa > 0:
                    _cancelar_tasks_ativas_worker()
                    print(f"🗑️ [Firebase] Limpeza remota da fila detectada (/fila_studio vazio). {qtd_limpa} item(ns) local(is) removido(s).")
                    return qtd_limpa
            return 0

        acoes_executadas = 0
        with self.lock:
            for job_id, r_job in list(remoto.items()):
                if not isinstance(r_job, dict):
                    continue
                r_job["id"] = r_job.get("id") or job_id
                cfg_remoto = r_job.get("config_geracao")
                if not isinstance(cfg_remoto, dict) or "prompt_final" not in cfg_remoto:
                    r_job["config_geracao"] = construir_config_geracao_artefato(r_job)
                st = r_job.get("status", "na_fila")

                if st == "concluido":
                    self.jobs.pop(job_id, None)
                    self._delete_job_firebase_async(job_id)
                    acoes_executadas += 1
                    continue

                if st == "cancelado_pendente_excluir":
                    self._remover_arquivo_staging_job(r_job)
                    self.jobs.pop(job_id, None)
                    self._delete_job_firebase_async(job_id)
                    acoes_executadas += 1
                    continue

                if st == "aprovado_pendente_mover":
                    self.jobs[job_id] = r_job
                    res_aprov = self.aprovar_job_revisao(job_id)
                    if not res_aprov.get("ok"):
                        r_job["status"] = "erro"
                        r_job["erro_log"] = res_aprov.get("erro", "Falha ao aprovar arquivo em staging.")
                        self.jobs[job_id] = r_job
                        self._sync_job_firebase_async(r_job)
                    acoes_executadas += 1
                    continue

                if st == "na_fila" and r_job.get("limpar_staging_anterior"):
                    self._remover_arquivo_staging_job(r_job)
                    r_job.pop("limpar_staging_anterior", None)
                    self.jobs[job_id] = r_job
                    self._sync_job_firebase_async(r_job)
                    acoes_executadas += 1
                    continue

                local_job = self.jobs.get(job_id)
                if not local_job:
                    self.jobs[job_id] = r_job
                    acoes_executadas += 1
                elif st in ("na_fila", "aguardando_cota") and local_job.get("status") == "revisao":
                    # Caso tenha sido clicado Tentar de Novo online
                    self._remover_arquivo_staging_job(local_job)
                    self.jobs[job_id] = r_job
                    acoes_executadas += 1

            if acoes_executadas > 0:
                self.salvar_no_disco()
                print(f"📥 [Firebase] {acoes_executadas} atualização(ões) sincronizada(s) de /fila_studio.")
        return acoes_executadas

    def obter_contadores(self) -> Dict[str, Any]:
        with self.lock:
            contagem = {
                "na_fila": 0,
                "gerando": 0,
                "aguardando_cota": 0,
                "revisao": 0,
                "concluido": 0,
                "erro": 0
            }
            for j in self.jobs.values():
                st = j.get("status", "na_fila")
                if st in contagem:
                    contagem[st] += 1
            return {
                **contagem,
                "total_ativos": contagem["na_fila"] + contagem["gerando"] + contagem["aguardando_cota"],
                "cota_status": "Pausada" if (self.cota_status == "Pausada" or contagem["aguardando_cota"] > 0) else "OK",
                "ultimo_erro_cota": self.ultimo_erro_cota
            }

    def listar_fila(self, apenas_revisao: bool = False) -> Dict[str, Any]:
        with self.lock:
            todos = sorted(self.jobs.values(), key=chave_ordenacao_hierarquica_job)
            if apenas_revisao:
                todos = [j for j in todos if j.get("status") == "revisao"]
            contadores = self.obter_contadores()
            return {
                "ok": True,
                "cota_status": contadores["cota_status"],
                "contadores": contadores,
                "jobs": todos
            }

    def _criar_ou_atualizar_job_unico(self, item: Dict[str, Any], sincronizar_firebase: bool = True) -> Dict[str, Any]:
        materia_id = str(item.get("materia_id") or "").strip()
        aula_id = str(item.get("aula_id") or "").strip()
        tipo_art = str(item.get("tipo_artefato") or "").strip().lower()
        if tipo_art not in TIPOS_ARTEFATOS_CONFIG:
            raise ValueError(f"Tipo de artefato inválido: '{tipo_art}'. Permitidos: {TODOS_OS_TIPOS}")

        acao = str(item.get("acao") or "gerar").strip().lower()
        if acao not in ("gerar", "regerar"):
            acao = "regerar" if item.get("url_antiga") else "gerar"

        # Evita duplicar job que já está ativo (`na_fila`, `gerando`, `aguardando_cota`) para a mesma aula e tipo
        for existente in self.jobs.values():
            if (
                existente.get("materia_id") == materia_id
                and existente.get("aula_id") == aula_id
                and existente.get("tipo_artefato") == tipo_art
                and existente.get("status") in ("na_fila", "gerando", "aguardando_cota")
            ):
                return existente

        cfg = TIPOS_ARTEFATOS_CONFIG[tipo_art]
        job_id = str(item.get("id") or f"job_{int(time.time() * 1000)}_{uuid.uuid4().hex[:6]}")
        ext = cfg["extensao"]
        staging_rel = f"staging/{job_id}_{tipo_art}{ext}"

        novo_job: Dict[str, Any] = {
            "id": job_id,
            "semestre_id": str(item.get("semestre_id") or ""),
            "semestre_nome": str(item.get("semestre_nome") or ""),
            "materia_id": materia_id,
            "materia_nome": str(item.get("materia_nome") or materia_id),
            "aula_id": aula_id,
            "aula_nome": str(item.get("aula_nome") or aula_id),
            "aula_titulo": str(item.get("aula_titulo") or item.get("aula_nome") or aula_id),
            "pasta_aula": str(item.get("pasta_aula") or ""),
            "notebook_url": str(item.get("notebook_url") or ""),
            "tipo_artefato": tipo_art,
            "label_artefato": cfg["label"],
            "acao": acao,
            "url_antiga": str(item.get("url_antiga") or ""),
            "caminho_staging": staging_rel,
            "staging_drive_path": "",
            "staging_drive_id": "",
            "staging_drive_url": "",
            "caminho_destino": "",
            "requer_revisao": bool(cfg["requer_revisao"]),
            "auto_aprovado": False,
            "status": "aguardando_cota" if self.cota_status == "Pausada" else "na_fila",
            "erro_log": "",
            "admin_gate": STUDIO_ADMIN_GATE,
            "timestamp": int(item.get("timestamp") or int(time.time() * 1000))
        }
        novo_job["config_geracao"] = item.get("config_geracao") or construir_config_geracao_artefato(novo_job)
        if item.get("simular_cota_excedida"):
            novo_job["simular_cota_excedida"] = True

        self.jobs[job_id] = novo_job
        if sincronizar_firebase:
            self._sync_job_firebase_async(novo_job)
        return novo_job

    def enfileirar(self, payload: Dict[str, Any]) -> Dict[str, Any]:
        """
        Enfileira 1 item, 1 aula completa (`escopo == 'all'` ou `tipos: [...]`)
        ou um lote de matéria/geral (`escopo == 'batch_materia'` ou `itens: [...]`).
        Retorna imediatamente (< 20ms).
        """
        criados: List[Dict[str, Any]] = []
        with self.lock:
            escopo = str(payload.get("escopo") or "item").strip().lower()

            if isinstance(payload.get("itens"), list) and len(payload["itens"]) > 0:
                for sub in payload["itens"]:
                    if isinstance(sub, dict):
                        criados.append(self._criar_ou_atualizar_job_unico(sub, sincronizar_firebase=False))

            elif escopo == "all" or str(payload.get("tipo_artefato") or "").lower() == "all":
                tipos_alvo = payload.get("tipos") or TODOS_OS_TIPOS
                urls_antigas = payload.get("urls_antigas") or {}
                for t in tipos_alvo:
                    if t in TIPOS_ARTEFATOS_CONFIG:
                        url_ant = urls_antigas.get(t, "")
                        sub_item = {
                            **payload,
                            "tipo_artefato": t,
                            "acao": "regerar" if url_ant else payload.get("acao", "gerar"),
                            "url_antiga": url_ant
                        }
                        criados.append(self._criar_ou_atualizar_job_unico(sub_item, sincronizar_firebase=False))
            else:
                criados.append(self._criar_ou_atualizar_job_unico(payload, sincronizar_firebase=False))

            self.salvar_no_disco()
            if criados:
                self._sync_jobs_lote_firebase_async(criados)
            contadores = self.obter_contadores()

        return {
            "ok": True,
            "enfileirados": len(criados),
            "jobs_criados": criados,
            "contadores": contadores
        }

    def _chave_conflito_caderno_tipo(self, job: Dict[str, Any]) -> Tuple[str, str]:
        """Trava duplicidade apenas no mesmo par (caderno NotebookLM, tipo de artefato)."""
        nb_id = extrair_notebook_id(job.get("notebook_url", ""))
        chave_aula = nb_id or str(job.get("aula_id") or job.get("id") or "")
        return (chave_aula, str(job.get("tipo_artefato") or "").strip().lower())

    def obter_proximos_jobs_da_fila(self, limite: int = MAX_CONCORRENCIA_GERACAO) -> List[Dict[str, Any]]:
        """
        Seleciona até `limite` jobs simultâneos respeitando:
        1. Guardião de Cota / Disjuntor (Circuit Breaker): pausa se `cota_status == 'Pausada'` ou auto-relogin ativo.
        2. Teto global de `MAX_CONCORRENCIA_GERACAO` (padrão 10) em execução paralela.
        3. Ordem Hierárquica Estrita: Semestre (1°→8°) > Matéria inteira > Aula (1→N) >
           Artefato (mindmap→flashcards→quiz→relatorio→infografico→slides→audio→video).
        4. Exclusão mútua apenas por `(caderno, tipo_artefato)` para permitir gerar todos os tipos da aula ao mesmo tempo.
        """
        with self.lock:
            if self._auth_relogin_em_andamento:
                return []
            agora = time.time()
            if self.cota_status == "Pausada":
                if (agora - self.cota_pausada_em) >= INTERVALO_RETRY_COTA_SEGUNDOS:
                    self.retomar_cota_interna()
                else:
                    return []

            gerando_atuais = [
                j for j in self.jobs.values()
                if j.get("status") == "gerando"
            ]
            vagas = max(0, min(limite, MAX_CONCORRENCIA_GERACAO - len(gerando_atuais)))
            if vagas <= 0:
                return []

            chaves_ocupadas: Set[Tuple[str, str]] = {
                self._chave_conflito_caderno_tipo(j) for j in gerando_atuais
            }

            candidatos = [
                j for j in self.jobs.values()
                if j.get("status") == "na_fila"
            ]
            if not candidatos:
                return []

            candidatos.sort(key=chave_ordenacao_hierarquica_job)

            escolhidos: List[Dict[str, Any]] = []
            for cand in candidatos:
                if len(escolhidos) >= vagas:
                    break
                chave = self._chave_conflito_caderno_tipo(cand)
                if chave in chaves_ocupadas:
                    continue
                chaves_ocupadas.add(chave)
                cand["status"] = "gerando"
                cand["erro_log"] = ""
                escolhidos.append(cand)

            if escolhidos:
                self.salvar_no_disco()
                self._sync_jobs_lote_firebase_async(escolhidos)

            return escolhidos

    def _chave_conflito_caderno_tipo(self, job: Dict[str, Any]) -> Tuple[str, str]:
        """Trava duplicidade apenas no mesmo par (caderno NotebookLM, tipo de artefato)."""
        nb_id = extrair_notebook_id(job.get("notebook_url", ""))
        chave_aula = nb_id or str(job.get("aula_id") or job.get("id") or "")
        return (chave_aula, str(job.get("tipo_artefato") or "").strip().lower())

    def get_queue_empty(self) -> bool:
        return len(self.jobs) == 0

    def obter_proximo_job_da_fila(self) -> Optional[Dict[str, Any]]:
        """Retorna o próximo job prioritário pronto para execução."""
        escolhidos = self.obter_proximos_jobs_da_fila(limite=1)
        return escolhidos[0] if escolhidos else None

    def acionar_guardiao_cota(self, job_atual_id: str, motivo_erro: str) -> None:
        """
        Regra de Ouro Nº 4 (Guardião de Cota Persistente):
        Quando a cota ou sessão do Google NotebookLM expira, nenhum item é perdido.
        O job atual e os demais `na_fila` recebem status `aguardando_cota`.
        """
        with self.lock:
            self.cota_status = "Pausada"
            self.cota_pausada_em = time.time()
            self.ultimo_erro_cota = motivo_erro

            afetados: List[Dict[str, Any]] = []
            for j in self.jobs.values():
                if j["id"] == job_atual_id or j.get("status") in ("na_fila", "gerando"):
                    j["status"] = "aguardando_cota"
                    j["erro_log"] = f"Aguardando normalização: {motivo_erro}"
                    afetados.append(j)

            self.salvar_no_disco()
            if afetados:
                self._sync_jobs_lote_firebase_async(afetados)

    def retomar_cota_interna(self, resetar_relogin: bool = False) -> int:
        """Retoma todos os jobs com status `aguardando_cota` para `na_fila`."""
        with self.lock:
            self.cota_status = "OK"
            self.cota_pausada_em = 0.0
            if resetar_relogin:
                self._tentativas_relogin_ts.clear()
            afetados: List[Dict[str, Any]] = []
            for j in self.jobs.values():
                if j.get("status") == "aguardando_cota":
                    j["status"] = "na_fila"
                    j.pop("simular_cota_excedida", None)
                    afetados.append(j)
            self.salvar_no_disco()
            if afetados:
                self._sync_jobs_lote_firebase_async(afetados)
            return len(afetados)

    def resolver_caminho_destino_oficial(self, job: Dict[str, Any]) -> Path:
        """Calcula o caminho físico oficial na pasta da aula para salvar o artefato."""
        tipo = job.get("tipo_artefato", "")
        cfg = TIPOS_ARTEFATOS_CONFIG.get(tipo, {})
        pasta_rel = str(job.get("pasta_aula") or "").replace("/", os.sep).strip(os.sep)

        # Se for regeração e existir arquivo antigo em caminho relativo conhecido, preserva o nome ou usa padrão
        nome_padrao = cfg.get("nome_padrao", f"{tipo}{cfg.get('extensao', '.dat')}")
        url_antiga = str(job.get("url_antiga") or "").replace("\\", "/").strip()
        if url_antiga and "/" in url_antiga and not url_antiga.startswith("http"):
            nome_antigo = Path(url_antiga).name
            if nome_antigo and Path(nome_antigo).suffix.lower() == cfg.get("extensao", "").lower():
                nome_padrao = nome_antigo

        is_test_mode = bool(job.get("simular_geracao_local")) or not self.enable_firebase or self.staging_dir != STAGING_DIR
        if is_test_mode:
            base_dir = self.staging_dir / "destino_oficial"
        else:
            base_dir = BASE_DRIVE_DIR if BASE_DRIVE_DIR.exists() else (SCRIPT_DIR / "arquivos_aulas")
        if pasta_rel:
            pasta_final = base_dir / pasta_rel
        else:
            pasta_final = base_dir / slugify_py(job.get("materia_nome", "materia")) / slugify_py(job.get("aula_nome", "aula"))

        pasta_final.mkdir(parents=True, exist_ok=True)
        return pasta_final / nome_padrao

    def finalizar_geracao_job(self, job_id: str, staging_file: Path) -> Dict[str, Any]:
        """
        Chamado quando o `notebooklm-py` conclui o download do artefato.
        - Se for um dos 4 artefatos NÃO-VISUAIS (`mindmap`, `flashcards`, `quiz`, `relatorio`):
          envia/salva direto na pasta oficial da aula, atualiza o `db.json` e marca como
          `concluido` (`auto_aprovado = True`), sem passar por `revisao`!
        - Se for um artefato VISUAL/MÍDIA (`infografico`, `slides`, `video`, `audio`):
          envia para `_staging_studio` no Google Drive, preenche `staging_drive_id` /
          `staging_drive_url` e muda o status para `revisao` aguardando Diff A/B.
        """
        with self.lock:
            job = self.jobs.get(job_id)
            if not job:
                return {"ok": False, "erro": "Job não encontrado."}

            if not staging_file.exists():
                return {"ok": False, "erro": f"Arquivo gerado ausente: {staging_file}"}

            tipo = job.get("tipo_artefato", "")
            cfg = TIPOS_ARTEFATOS_CONFIG.get(tipo, {})
            requer_revisao = cfg.get("requer_revisao", True)
            is_test_mode = bool(job.get("simular_geracao_local")) or not self.enable_firebase or self.staging_dir != STAGING_DIR

            if not requer_revisao:
                destino_oficial = self.resolver_caminho_destino_oficial(job)
                drive_id = ""
                if not is_test_mode:
                    token = obter_token_drive_silencioso()
                    dest_folder_id = _localizar_pasta_aula_drive_id(token, str(job.get("pasta_aula") or "")) if token else ""
                    if dest_folder_id:
                        drive_id = upload_arquivo_drive_multipart(
                            staging_file,
                            dest_folder_id,
                            nome_destino=destino_oficial.name,
                            mime_type=cfg.get("mime_type")
                        )

                if not drive_id:
                    shutil.copy2(staging_file, destino_oficial)

                registrar_artefato_no_db(
                    job,
                    destino_oficial,
                    drive_file_id=drive_id,
                    conteudo_path=staging_file
                )
                self._remover_arquivo_staging_job(job)
                job["caminho_destino"] = str(destino_oficial)
                job["auto_aprovado"] = True
                job["status"] = "concluido"
                if drive_id:
                    job["staging_drive_id"] = drive_id
                print(
                    f"✅ [Auto-Aprovado] '{destino_oficial.name}' salvo para "
                    f"'{job.get('pasta_aula')}' (drive_id={drive_id or 'local'})"
                )
                self.jobs.pop(job_id, None)
                self._delete_job_firebase_async(job_id)
            else:
                drive_id = ""
                drive_preview_url = ""
                if not is_test_mode:
                    token = obter_token_drive_silencioso()
                    pasta_stg_id = _obter_pasta_staging_drive_id(token) if token else ""
                    if pasta_stg_id:
                        print(f"☁️ [Staging Drive] Enviando '{staging_file.name}' para _staging_studio...")
                        drive_id = upload_arquivo_drive_multipart(
                            staging_file,
                            pasta_stg_id,
                            nome_destino=staging_file.name,
                            mime_type=cfg.get("mime_type")
                        )
                    if not drive_id and DRIVE_STAGING_DIR and BASE_DRIVE_DIR.exists():
                        drive_staging_file = DRIVE_STAGING_DIR / staging_file.name
                        if drive_staging_file.resolve() != staging_file.resolve():
                            try:
                                shutil.copy2(staging_file, drive_staging_file)
                            except Exception:
                                pass
                        drive_id = tentar_extrair_drive_id_arquivo(drive_staging_file)

                    if drive_id:
                        drive_preview_url = montar_url_preview_drive(drive_id, tipo)
                        print(f"☁️ [Staging Drive] OK! id={drive_id} | preview={drive_preview_url}")
                    else:
                        print("⚠️ [Staging Drive] Upload/ID do Google Drive indisponível; mantendo preview local em /staging/.")

                if DRIVE_STAGING_DIR and DRIVE_STAGING_DIR != STAGING_DIR:
                    job["staging_drive_path"] = str(DRIVE_STAGING_DIR / staging_file.name)
                else:
                    job["staging_drive_path"] = str(staging_file)
                job["staging_drive_id"] = drive_id
                job["staging_drive_url"] = drive_preview_url
                job["status"] = "revisao"
                job["auto_aprovado"] = False
                self._sync_job_firebase_async(job)

            self.salvar_no_disco()
            return {"ok": True, "job": job}

    # ==========================================================================
    # 🎯 AS 3 AÇÕES ESTRITAS DO PAINEL DE APROVAÇÃO (FASE 3)
    # ==========================================================================
    def aprovar_job_revisao(self, job_id: str) -> Dict[str, Any]:
        """
        Botão 1: `[✅ Aprovar]`
        Move/salva o arquivo novo na pasta/destino oficial (Google Drive e local),
        atualiza o `db.json`/banco de dados e remove o card da lista de revisão.
        """
        with self.lock:
            job = self.jobs.get(job_id)
            if not job:
                return {"ok": False, "erro": f"Job '{job_id}' não encontrado."}

            staging_rel = str(job.get("caminho_staging") or "")
            nome_arq = Path(staging_rel).name if staging_rel else ""
            candidatos_staging = [
                SCRIPT_DIR / staging_rel.replace("/", os.sep) if staging_rel else Path(),
                self.staging_dir / nome_arq if nome_arq else Path(),
                Path(str(job.get("staging_drive_path") or "")),
                DRIVE_STAGING_DIR / nome_arq if (nome_arq and DRIVE_STAGING_DIR) else Path(),
            ]
            staging_file = next((p for p in candidatos_staging if str(p) not in ("", ".") and p.exists() and p.is_file()), None)
            destino_oficial = self.resolver_caminho_destino_oficial(job)
            is_test_mode = bool(job.get("simular_geracao_local")) or not self.enable_firebase or self.staging_dir != STAGING_DIR
            drive_staging_id = str(job.get("staging_drive_id") or "").strip()

            if not is_test_mode and not staging_file and not drive_staging_id:
                return {"ok": False, "erro": "Arquivo de staging não encontrado localmente nem no Google Drive."}

            final_drive_id = ""
            if is_test_mode:
                if staging_file and staging_file.exists():
                    shutil.move(str(staging_file), str(destino_oficial))
                    self._remover_arquivo_staging_job(job)
                elif job.get("simular_geracao_local"):
                    _gerar_conteudo_fallback_estruturado(job, destino_oficial)
            else:
                if drive_staging_id:
                    moved_id = mover_arquivo_drive_para_pasta_aula(
                        drive_staging_id,
                        str(job.get("pasta_aula") or ""),
                        destino_oficial.name
                    )
                    if moved_id:
                        final_drive_id = moved_id
                        # Evita que _remover_arquivo_staging_job apague o arquivo recém-movido
                        job["staging_drive_id"] = ""

                if not final_drive_id and staging_file and staging_file.exists():
                    token = obter_token_drive_silencioso()
                    dest_folder_id = _localizar_pasta_aula_drive_id(token, str(job.get("pasta_aula") or "")) if token else ""
                    if dest_folder_id:
                        tipo = job.get("tipo_artefato", "")
                        cfg = TIPOS_ARTEFATOS_CONFIG.get(tipo, {})
                        final_drive_id = upload_arquivo_drive_multipart(
                            staging_file,
                            dest_folder_id,
                            nome_destino=destino_oficial.name,
                            mime_type=cfg.get("mime_type")
                        )

                if not final_drive_id:
                    if staging_file and staging_file.exists():
                        shutil.move(str(staging_file), str(destino_oficial))
                    else:
                        return {"ok": False, "erro": "Não foi possível mover nem copiar o arquivo aprovado para a pasta da aula."}

                db_atualizado = registrar_artefato_no_db(
                    job,
                    destino_oficial,
                    drive_file_id=final_drive_id,
                    conteudo_path=staging_file
                )
                self._remover_arquivo_staging_job(job)
                job["caminho_destino"] = str(destino_oficial)
                job["status"] = "concluido"
                job["aprovado_em"] = int(time.time() * 1000)
                print(
                    f"✅ [Aprovado] '{destino_oficial.name}' movido para "
                    f"'{job.get('pasta_aula')}' (drive_id={final_drive_id or 'local'})"
                )
                del self.jobs[job_id]
                self.salvar_no_disco()
                self._delete_job_firebase_async(job_id)
                return {
                    "ok": True,
                    "acao": "aprovado",
                    "job_id": job_id,
                    "drive_id": final_drive_id,
                    "caminho_destino": str(destino_oficial),
                    "db_atualizado": db_atualizado,
                    "contadores": self.obter_contadores()
                }

            job["caminho_destino"] = str(destino_oficial)
            job["status"] = "concluido"
            job["aprovado_em"] = int(time.time() * 1000)

            db_atualizado = registrar_artefato_no_db(job, destino_oficial)
            del self.jobs[job_id]
            self.salvar_no_disco()
            self._delete_job_firebase_async(job_id)

            return {
                "ok": True,
                "acao": "aprovado",
                "job_id": job_id,
                "caminho_destino": str(destino_oficial),
                "db_atualizado": db_atualizado,
                "contadores": self.obter_contadores()
            }

    def tentar_novamente_job_revisao(self, job_id: str) -> Dict[str, Any]:
        """
        Botão 2: `[🔄 Tentar de Novo]`
        Apaga o arquivo temporário do `staging/` (e do Drive `_staging_studio/`)
        e volta o status do job para `na_fila` para regerar usando o prompt padrão.
        """
        with self.lock:
            job = self.jobs.get(job_id)
            if not job:
                return {"ok": False, "erro": f"Job '{job_id}' não encontrado."}

            self._remover_arquivo_staging_job(job)

            job["status"] = "na_fila"
            job["erro_log"] = ""
            job["staging_drive_id"] = ""
            job["staging_drive_url"] = ""
            job["timestamp"] = int(time.time() * 1000)
            self.salvar_no_disco()
            self._sync_job_firebase_async(job)

            return {
                "ok": True,
                "acao": "tentar_novamente",
                "job": job,
                "contadores": self.obter_contadores()
            }

    def cancelar_job_revisao(self, job_id: str) -> Dict[str, Any]:
        """
        Botão 3: `[✖]` (Botão X no canto do card)
        Cancela/apaga a solicitação, exclui o arquivo do `staging/` (e do Drive `_staging_studio/`),
        remove o item da lista de revisão e mantém o arquivo antigo intacto no banco.
        """
        with self.lock:
            job = self.jobs.get(job_id)
            if not job:
                return {"ok": False, "erro": f"Job '{job_id}' não encontrado."}

            self._remover_arquivo_staging_job(job)

            del self.jobs[job_id]
            self.salvar_no_disco()
            self._delete_job_firebase_async(job_id)

            return {
                "ok": True,
                "acao": "cancelado",
                "job_id": job_id,
                "contadores": self.obter_contadores()
            }

    async def _tratar_erro_autenticacao_async(
        self,
        job_id: str,
        exc: Exception,
        job_iniciado_em: float,
        epoch_inicio: int
    ) -> bool:
        """
        Disjuntor de Autenticação com Auto-Relogin (`python -m notebooklm login`):
        - Executa apenas 1 processo de login por vez mesmo com 10 jobs paralelos falhando juntos.
        - Se outro job já renovou a sessão depois que este job começou, apenas devolve este job para `na_fila`.
        - Quando o navegador salva o login com sucesso, retoma toda a fila automaticamente.
        """
        deve_executar_relogin = False
        motivo_pausa = f"Sessão NotebookLM expirada: {exc}"

        with self.lock:
            if self._fila_epoch != epoch_inicio or job_id not in self.jobs:
                return False

            agora = time.time()
            # Caso 1: Uma renovação de login já foi concluída após este job iniciar (ou dentro do cooldown)
            if self._ultimo_relogin_ok_ts > 0 and (
                self._ultimo_relogin_ok_ts >= job_iniciado_em
                or (agora - self._ultimo_relogin_ok_ts) < AUTO_RELOGIN_COOLDOWN_SEGUNDOS
            ):
                cur_job = self.jobs.get(job_id)
                if cur_job:
                    cur_job["status"] = "na_fila"
                    cur_job["erro_log"] = ""
                    self.salvar_no_disco()
                    self._sync_job_firebase_async(cur_job)
                print(
                    f"🔄 [Disjuntor Auth] Job {job_id} usava cookies anteriores ao relogin recente; "
                    f"devolvido para 'na_fila' automaticamente."
                )
                return True

            # Caso 2: Outro job paralelo já está executando `notebooklm login` agora
            if self._auth_relogin_em_andamento:
                cur_job = self.jobs.get(job_id)
                if cur_job and cur_job.get("status") in ("gerando", "na_fila"):
                    cur_job["status"] = "aguardando_cota"
                    cur_job["erro_log"] = "Aguardando renovação automática de login do NotebookLM..."
                    self.salvar_no_disco()
                    self._sync_job_firebase_async(cur_job)
                return True

            # Limpa timestamps fora da janela de proteção contra loop infinito
            self._tentativas_relogin_ts = [
                t for t in self._tentativas_relogin_ts
                if (agora - t) < AUTO_RELOGIN_JANELA_SEGUNDOS
            ]

            pode_tentar_auto = (
                self.auto_relogin_enabled
                and len(self._tentativas_relogin_ts) < AUTO_RELOGIN_MAX_TENTATIVAS_JANELA
            )

            print(f"🔐 [Disjuntor Auth] Sessão do NotebookLM expirada no job {job_id}: {exc}")

            if pode_tentar_auto:
                self._auth_relogin_em_andamento = True
                self._tentativas_relogin_ts.append(agora)
                deve_executar_relogin = True
                self.acionar_guardiao_cota(
                    job_id,
                    "Sessão NotebookLM expirada — executando relogin automático..."
                )
            else:
                print(
                    f"   👉 Fila pausada automaticamente para evitar loop de erros. "
                    f"Renove com: {NOTEBOOKLM_PYTHON_EXE} -m notebooklm login"
                )
                self.acionar_guardiao_cota(job_id, motivo_pausa)
                return True

        if not deve_executar_relogin:
            return True

        try:
            res_login = await asyncio.to_thread(executar_relogin_notebooklm_sync)
        finally:
            with self.lock:
                self._auth_relogin_em_andamento = False

        if res_login.get("ok"):
            pausa_pos = float(getattr(self, "auto_relogin_pos_salvar_seg", 2.0))
            if pausa_pos > 0:
                await asyncio.sleep(pausa_pos)
            with self.lock:
                self._ultimo_relogin_ok_ts = time.time()
                if self._fila_epoch != epoch_inicio:
                    return True
            retomados = self.retomar_cota_interna()
            print(
                f"🚀 [Auto-Relogin] Sessão salva e validada! "
                f"{retomados} job(s) retomado(s) automaticamente para a fila ativa."
            )
            return True

        erro_relogin = res_login.get("erro", "Falha desconhecida no relogin.")
        with self.lock:
            if self._fila_epoch == epoch_inicio:
                self.cota_status = "Pausada"
                self.cota_pausada_em = time.time()
                self.ultimo_erro_cota = f"Auto-relogin falhou ({erro_relogin}). Execute: {NOTEBOOKLM_PYTHON_EXE} -m notebooklm login"
                self.salvar_no_disco()
        print(
            f"⏸️ [Disjuntor Auth] Fila mantida pausada (nenhum item perdido). "
            f"Rode manualmente: {NOTEBOOKLM_PYTHON_EXE} -m notebooklm login"
        )
        return True

    async def _executar_job_selecionado_async(self, job: Dict[str, Any]) -> bool:
        """Executa 1 job previamente alocado como `gerando`, tratando falhas, auto-relogin e disjuntor de cota."""
        job_id = job["id"]
        epoch_inicio = self._fila_epoch
        job_iniciado_em = time.time()
        staging_file = resolver_staging_file_path(job, staging_dir=self.staging_dir)
        staging_file.parent.mkdir(parents=True, exist_ok=True)

        try:
            await executar_geracao_notebooklm_async(job, staging_file)
            with self.lock:
                if self._fila_epoch != epoch_inicio:
                    return False
                cur_job = self.jobs.get(job_id)
                if not cur_job or cur_job.get("status") != "gerando":
                    # Disjuntor de cota, limpeza de fila ou cancelamento remoto alterou o estado
                    return False
            res = self.finalizar_geracao_job(job_id, staging_file)
            if not res.get("ok"):
                raise RuntimeError(res.get("erro", "Falha ao finalizar job."))
            return True
        except asyncio.CancelledError:
            return False
        except Exception as exc:
            with self.lock:
                if self._fila_epoch != epoch_inicio or job_id not in self.jobs:
                    return False
            if eh_erro_de_autenticacao_notebooklm(exc):
                await self._tratar_erro_autenticacao_async(
                    job_id=job_id,
                    exc=exc,
                    job_iniciado_em=job_iniciado_em,
                    epoch_inicio=epoch_inicio
                )
            elif eh_erro_de_cota(exc):
                print(f"⏸️ [Guardião de Cota / Circuit Breaker] Limite detectado no job {job_id}: {exc}")
                self.acionar_guardiao_cota(job_id, str(exc))
            else:
                with self.lock:
                    if self._fila_epoch != epoch_inicio:
                        return False
                    cur_job = self.jobs.get(job_id)
                    if cur_job and cur_job.get("status") == "gerando":
                        cur_job["status"] = "erro"
                        cur_job["erro_log"] = str(exc)
                        self._sync_job_firebase_async(cur_job)
                        self.salvar_no_disco()
                print(f"❌ [StudioWorker] Erro no job {job_id}: {exc}")
            return True

    async def processar_um_ciclo_async(self) -> bool:
        """
        Sincroniza com o Firebase (`/fila_studio`), aplica aprovações/exclusões remotas
        e processa o próximo job prioritário da fila.
        """
        self.sincronizar_com_firebase()
        job = self.obter_proximo_job_da_fila()
        if not job:
            return False
        return await self._executar_job_selecionado_async(job)

    async def processar_lote_paralelo_async(self, max_concorrencia: int = MAX_CONCORRENCIA_GERACAO) -> int:
        """
        Sincroniza com Firebase (`/fila_studio`), aloca até `max_concorrencia` jobs
        respeitando Via Rápida/Pesada + lock `(caderno, tipo)` e executa todos em paralelo.
        """
        self.sincronizar_com_firebase()
        jobs = self.obter_proximos_jobs_da_fila(limite=max_concorrencia)
        if not jobs:
            return 0
        await asyncio.gather(*(self._executar_job_selecionado_async(j) for j in jobs))
        return len(jobs)


# Instância global do gerenciador
queue_manager = StudioQueueManager()


# ==============================================================================
# 🔄 LOOP EM BACKGROUND DO WORKER (CONCORRÊNCIA INTELIGENTE + RETOMADA AUTOMÁTICA)
# ==============================================================================
_worker_running = False
_worker_tasks_lock = threading.Lock()
_worker_tasks_ativas: Set[asyncio.Task] = set()
_worker_event_loop: Optional[asyncio.AbstractEventLoop] = None


def _cancelar_tasks_ativas_worker() -> int:
    """Cancela imediatamente todas as tarefas assíncronas em andamento (chamado ao limpar a fila)."""
    canceladas = 0
    with _worker_tasks_lock:
        loop = _worker_event_loop
        tasks = list(_worker_tasks_ativas)
    for t in tasks:
        try:
            if not t.done():
                if loop and loop.is_running():
                    loop.call_soon_threadsafe(t.cancel)
                else:
                    t.cancel()
                canceladas += 1
        except Exception:
            pass
    return canceladas


async def loop_worker_background() -> None:
    global _worker_running, _worker_event_loop
    if _worker_running:
        return
    _worker_running = True
    with _worker_tasks_lock:
        _worker_event_loop = asyncio.get_running_loop()
    print(
        f"🚀 [StudioWorker] Loop paralelo iniciado "
        f"(Máx: {MAX_CONCORRENCIA_GERACAO} simultâneos | Stagger: {INTERVALO_STAGGER_DISPARO_SEGUNDOS}s | "
        f"Ordem: Semestre 1→8 > Matéria > Aula > Artefato | Guardião de Cota + Auto-Relogin ativos)."
    )
    tasks_ativas: Set[asyncio.Task] = set()
    try:
        while _worker_running:
            queue_manager.sincronizar_com_firebase()
            novos = queue_manager.obter_proximos_jobs_da_fila(limite=MAX_CONCORRENCIA_GERACAO)
            for job in novos:
                t = asyncio.create_task(queue_manager._executar_job_selecionado_async(job))
                tasks_ativas.add(t)
                with _worker_tasks_lock:
                    _worker_tasks_ativas.add(t)

            if tasks_ativas:
                done, pending = await asyncio.wait(
                    tasks_ativas,
                    timeout=INTERVALO_LOOP_WORKER_SEGUNDOS,
                    return_when=asyncio.FIRST_COMPLETED
                )
                for d in done:
                    with _worker_tasks_lock:
                        _worker_tasks_ativas.discard(d)
                    try:
                        d.result()
                    except asyncio.CancelledError:
                        pass
                    except Exception as exc:
                        print(f"⚠️ [StudioWorker] Exceção em tarefa paralela: {exc}")
                tasks_ativas = set(pending)
            else:
                await asyncio.sleep(INTERVALO_LOOP_WORKER_SEGUNDOS)
    finally:
        _worker_running = False
        for t in list(tasks_ativas):
            t.cancel()
        if tasks_ativas:
            await asyncio.gather(*tasks_ativas, return_exceptions=True)
        with _worker_tasks_lock:
            _worker_tasks_ativas.clear()
            _worker_event_loop = None


def salvar_relatorio_fontes_no_db(payload: Dict[str, Any]) -> Dict[str, Any]:
    """Salva o relatório de fontes do NotebookLM dentro da aula no `db.json` e Firebase."""
    db_data = carregar_db_local()
    if not db_data:
        return {"ok": False, "erro": "db.json não encontrado."}

    ctx = localizar_aula_no_db(
        db_data,
        materia_id=str(payload.get("materia_id") or ""),
        aula_id=str(payload.get("aula_id") or ""),
        pasta_aula=str(payload.get("pasta_aula") or ""),
        notebook_url=str(payload.get("notebook_url") or "")
    )
    if not ctx:
        return {"ok": False, "erro": "Aula não localizada no db.json."}

    aula_node = ctx["aula_node"]
    aula_node["relatorioFontesNotebook"] = payload.get("fontes", [])
    aula_node["diagnosticoFontesNotebook"] = payload.get("diagnostico", {})
    aula_node["fontesAtualizadoEm"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())

    ok = salvar_db_local_e_nuvem(db_data)
    return {
        "ok": ok,
        "aula_id": payload.get("aula_id"),
        "total_fontes_salvas": len(aula_node["relatorioFontesNotebook"])
    }


# ==============================================================================
# 🌐 DEFINIÇÃO DA API FASTAPI (COM FALLBACK HTTP NATIVO ZERO-DEPENDÊNCIA)
# ==============================================================================
try:
    from fastapi import FastAPI, Request, HTTPException, Query
    from fastapi.middleware.cors import CORSMiddleware
    from fastapi.staticfiles import StaticFiles
    from fastapi.responses import JSONResponse
    FASTAPI_DISPONIVEL = True
except ImportError:
    FASTAPI_DISPONIVEL = False
    FastAPI = None  # type: ignore

if FASTAPI_DISPONIVEL:
    from contextlib import asynccontextmanager

    @asynccontextmanager
    async def _lifespan(_app: FastAPI):
        global _worker_running
        task = asyncio.create_task(loop_worker_background())
        try:
            yield
        finally:
            _worker_running = False
            task.cancel()
            try:
                await task
            except asyncio.CancelledError:
                pass

    app = FastAPI(
        title="Study OS — Studio Worker API",
        description="Worker local para geração de artefatos no NotebookLM e Painel de Revisão Diff A/B",
        version="1.0.0",
        lifespan=_lifespan
    )

    app.add_middleware(
        CORSMiddleware,
        allow_origins=["*"],
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    app.mount(
        "/staging",
        StaticFiles(directory=str(STAGING_DIR)),
        name="staging"
    )

    @app.get("/api/studio/health")
    async def get_health() -> Dict[str, Any]:
        return {
            "ok": True,
            "service": "studio_worker",
            "port": PORTA_WORKER,
            "contadores": queue_manager.obter_contadores()
        }

    @app.post("/api/studio/enfileirar")
    async def post_enfileirar(request: Request) -> Dict[str, Any]:
        payload = await request.json()
        return queue_manager.enfileirar(payload)

    @app.get("/api/studio/fila")
    async def get_fila(apenas_revisao: bool = Query(False)) -> Dict[str, Any]:
        return queue_manager.listar_fila(apenas_revisao=apenas_revisao)

    @app.get("/api/studio/fontes")
    async def get_fontes(
        notebook_url: str = Query(""),
        materia_id: str = Query(""),
        aula_id: str = Query("")
    ) -> Dict[str, Any]:
        return await listar_fontes_notebooklm_async(notebook_url, materia_id, aula_id)

    @app.post("/api/studio/fontes/adicionar")
    async def post_adicionar_fonte(request: Request) -> Dict[str, Any]:
        body = await request.json()
        return await adicionar_fonte_notebooklm_async(
            notebook_url=str(body.get("notebook_url") or ""),
            tipo_fonte=str(body.get("tipo_fonte") or "url"),
            valor=str(body.get("valor") or ""),
            titulo=str(body.get("titulo") or "")
        )

    @app.delete("/api/studio/fontes/remover")
    async def delete_remover_fonte(
        notebook_url: str = Query(""),
        fonte_id: str = Query("")
    ) -> Dict[str, Any]:
        return await remover_fonte_notebooklm_async(notebook_url, fonte_id)

    @app.post("/api/studio/fontes/salvar-db")
    async def post_salvar_fontes_db(request: Request) -> Dict[str, Any]:
        body = await request.json()
        return salvar_relatorio_fontes_no_db(body)

    @app.post("/api/studio/revisao/{job_id}/aprovar")
    async def post_aprovar_revisao(job_id: str) -> Dict[str, Any]:
        res = queue_manager.aprovar_job_revisao(job_id)
        if not res.get("ok"):
            raise HTTPException(status_code=404, detail=res.get("erro"))
        return res

    @app.post("/api/studio/revisao/{job_id}/tentar-novamente")
    async def post_tentar_novamente_revisao(job_id: str) -> Dict[str, Any]:
        res = queue_manager.tentar_novamente_job_revisao(job_id)
        if not res.get("ok"):
            raise HTTPException(status_code=404, detail=res.get("erro"))
        return res

    @app.delete("/api/studio/revisao/{job_id}")
    @app.post("/api/studio/revisao/{job_id}/cancelar")
    async def delete_cancelar_revisao(job_id: str) -> Dict[str, Any]:
        res = queue_manager.cancelar_job_revisao(job_id)
        if not res.get("ok"):
            raise HTTPException(status_code=404, detail=res.get("erro"))
        return res

    @app.post("/api/studio/retomar-cota")
    async def post_retomar_cota() -> Dict[str, Any]:
        qtd = queue_manager.retomar_cota_interna(resetar_relogin=True)
        return {
            "ok": True,
            "retomados": qtd,
            "contadores": queue_manager.obter_contadores()
        }

    @app.post("/api/studio/limpar-fila")
    async def post_limpar_fila() -> Dict[str, Any]:
        return await asyncio.to_thread(queue_manager.limpar_fila)

    @app.get("/api/studio/prompts")
    async def get_prompts_fixos() -> Dict[str, Any]:
        return {
            "ok": True,
            "prompts": PROMPTS_FIXOS,
            "tipos": TIPOS_ARTEFATOS_CONFIG
        }


# ==============================================================================
# 🛡️ SERVIDOR HTTP NATIVO DE FALLBACK (CASO FASTAPI/UVICORN NÃO ESTEJA INSTALADO)
# ==============================================================================
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler
import mimetypes


class StudioFallbackHTTPHandler(BaseHTTPRequestHandler):
    """
    Garante que `python studio_worker.py` funcione imediatamente na porta 8090
    com todos os endpoints REST e arquivos `/staging/*` mesmo em ambientes onde
    o usuário ainda não rodou `pip install fastapi uvicorn`.
    """

    def log_message(self, format: str, *args: Any) -> None:
        pass

    def _send_cors_headers(self) -> None:
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, Authorization")

    def _send_json(self, data: Dict[str, Any], status: int = 200) -> None:
        raw = json.dumps(data, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self._send_cors_headers()
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def _read_json_body(self) -> Dict[str, Any]:
        length = int(self.headers.get("Content-Length", "0") or "0")
        if length <= 0:
            return {}
        raw = self.rfile.read(length).decode("utf-8")
        return json.loads(raw) if raw else {}

    def do_OPTIONS(self) -> None:
        self.send_response(204)
        self._send_cors_headers()
        self.end_headers()

    def do_GET(self) -> None:
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path
        qs = urllib.parse.parse_qs(parsed.query)

        if path == "/api/studio/health":
            self._send_json({
                "ok": True,
                "service": "studio_worker",
                "port": PORTA_WORKER,
                "contadores": queue_manager.obter_contadores()
            })
            return

        if path == "/api/studio/fila":
            apenas_rev = qs.get("apenas_revisao", ["false"])[0].lower() == "true"
            self._send_json(queue_manager.listar_fila(apenas_revisao=apenas_rev))
            return

        if path == "/api/studio/fontes":
            nb_url = qs.get("notebook_url", [""])[0]
            mat_id = qs.get("materia_id", [""])[0]
            aula_id = qs.get("aula_id", [""])[0]
            res = asyncio.run(listar_fontes_notebooklm_async(nb_url, mat_id, aula_id))
            self._send_json(res)
            return

        if path == "/api/studio/prompts":
            self._send_json({"ok": True, "prompts": PROMPTS_FIXOS, "tipos": TIPOS_ARTEFATOS_CONFIG})
            return

        if path.startswith("/staging/"):
            rel_name = urllib.parse.unquote(path[len("/staging/"):]).lstrip("/\\")
            for base_stg in (STAGING_DIR, DRIVE_STAGING_DIR):
                target_file = (base_stg / rel_name).resolve()
                if target_file.exists() and str(target_file).startswith(str(base_stg.resolve())):
                    ctype, _ = mimetypes.guess_type(str(target_file))
                    raw_bytes = target_file.read_bytes()
                    self.send_response(200)
                    self._send_cors_headers()
                    self.send_header("Content-Type", ctype or "application/octet-stream")
                    self.send_header("Content-Length", str(len(raw_bytes)))
                    self.end_headers()
                    self.wfile.write(raw_bytes)
                    return
            self._send_json({"ok": False, "erro": "Arquivo de staging não encontrado."}, status=404)
            return

        self._send_json({"ok": False, "erro": f"Rota não encontrada: {path}"}, status=404)

    def do_POST(self) -> None:
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path

        if path == "/api/studio/enfileirar":
            body = self._read_json_body()
            self._send_json(queue_manager.enfileirar(body))
            return

        if path == "/api/studio/retomar-cota":
            qtd = queue_manager.retomar_cota_interna(resetar_relogin=True)
            self._send_json({"ok": True, "retomados": qtd, "contadores": queue_manager.obter_contadores()})
            return

        if path == "/api/studio/limpar-fila":
            self._send_json(queue_manager.limpar_fila())
            return

        if path == "/api/studio/fontes/adicionar":
            body = self._read_json_body()
            res = asyncio.run(adicionar_fonte_notebooklm_async(
                notebook_url=str(body.get("notebook_url") or ""),
                tipo_fonte=str(body.get("tipo_fonte") or "url"),
                valor=str(body.get("valor") or ""),
                titulo=str(body.get("titulo") or "")
            ))
            self._send_json(res)
            return

        if path == "/api/studio/fontes/salvar-db":
            body = self._read_json_body()
            self._send_json(salvar_relatorio_fontes_no_db(body))
            return

        m_rev = re.match(r"^/api/studio/revisao/([^/]+)/(aprovar|tentar-novamente|cancelar)$", path)
        if m_rev:
            job_id, acao = m_rev.group(1), m_rev.group(2)
            if acao == "aprovar":
                res = queue_manager.aprovar_job_revisao(job_id)
            elif acao == "tentar-novamente":
                res = queue_manager.tentar_novamente_job_revisao(job_id)
            else:
                res = queue_manager.cancelar_job_revisao(job_id)
            self._send_json(res, status=200 if res.get("ok") else 404)
            return

        self._send_json({"ok": False, "erro": f"Rota POST não encontrada: {path}"}, status=404)

    def do_DELETE(self) -> None:
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path
        qs = urllib.parse.parse_qs(parsed.query)

        if path == "/api/studio/fontes/remover":
            nb_url = qs.get("notebook_url", [""])[0]
            fonte_id = qs.get("fonte_id", [""])[0]
            res = asyncio.run(remover_fonte_notebooklm_async(nb_url, fonte_id))
            self._send_json(res)
            return

        m_del = re.match(r"^/api/studio/revisao/([^/]+)$", path)
        if m_del:
            job_id = m_del.group(1)
            res = queue_manager.cancelar_job_revisao(job_id)
            self._send_json(res, status=200 if res.get("ok") else 404)
            return

        self._send_json({"ok": False, "erro": f"Rota DELETE não encontrada: {path}"}, status=404)


def _porta_em_uso(host: str, porta: int) -> bool:
    """Retorna True se o socket já estiver aceitando conexões ou ocupado localmente."""
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            s.settimeout(0.3)
            if s.connect_ex((host, porta)) == 0:
                return True
    except OSError:
        pass
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as srv:
            srv.bind((host, porta))
        return False
    except OSError:
        return True


def _liberar_porta_em_uso(porta: int, host: str = HOST_WORKER) -> None:
    """
    Garante que nenhuma instância anterior do Studio Worker esteja ocupando a porta
    antes de subir o servidor FastAPI/HTTP, evitando `[WinError 10048]`.
    """
    if not _porta_em_uso(host, porta):
        return

    meu_pid = os.getpid()
    pids_alvo: List[int] = []
    if sys.platform == "win32":
        try:
            proc = subprocess.run(
                ["netstat", "-ano", "-p", "TCP"],
                capture_output=True,
                timeout=5
            )
            stdout_txt = (proc.stdout or b"").decode("latin-1", errors="ignore")
            padrao_porta = re.compile(rf":\s*{porta}\b")
            for linha in stdout_txt.splitlines():
                if "LISTENING" not in linha.upper():
                    continue
                partes = linha.split()
                if len(partes) < 5:
                    continue
                local_addr = partes[1]
                if not local_addr.endswith(f":{porta}") and not padrao_porta.search(local_addr):
                    continue
                try:
                    pid = int(partes[-1])
                except ValueError:
                    continue
                if pid > 4 and pid != meu_pid and pid not in pids_alvo:
                    pids_alvo.append(pid)

            for pid in pids_alvo:
                print(f"♻️ [StudioWorker] Substituindo instância anterior na porta {porta} (PID {pid})...")
                subprocess.run(
                    ["taskkill", "/F", "/PID", str(pid)],
                    capture_output=True,
                    timeout=5
                )
        except Exception as exc:
            print(f"⚠️ [StudioWorker] Não foi possível liberar a porta {porta} automaticamente: {exc}")

    # Aguarda brevemente o SO liberar o socket após o encerramento
    for _ in range(15):
        if not _porta_em_uso(host, porta):
            break
        time.sleep(0.2)


def iniciar_servidor() -> None:
    _liberar_porta_em_uso(PORTA_WORKER, HOST_WORKER)
    sessao = verificar_sessao_notebooklm()
    token_drive_ok = bool(obter_token_drive_silencioso())

    print("=" * 72)
    print(f"⚡ STUDY OS — STUDIO WORKER LOCAL (http://{HOST_WORKER}:{PORTA_WORKER})")
    print("=" * 72)
    print(f"📂 Fila Local       : {FILA_STUDIO_PATH}")
    print(f"🔥 Fila Online      : {FIREBASE_URL}/fila_studio")
    print(f"🗂️ Staging Local    : {STAGING_DIR}")
    print(f"☁️ Staging Drive    : {DRIVE_STAGING_DIR}")
    print(f"☁️ Google Drive API : {'✅ Conectado (token.json OK)' if token_drive_ok else '⚠️ Token ausente/expirado'}")
    if sessao["autenticado"]:
        print(f"🔐 NotebookLM Auth  : ✅ Autenticado ({sessao['storage_path'] or 'NOTEBOOKLM_AUTH_JSON'})")
    else:
        print(
            f"🔐 NotebookLM Auth  : ⚠️ NÃO AUTENTICADO! Execute no terminal:\n"
            f"                      {sys.executable} -m notebooklm login"
        )
    print(f"🔑 Auto-Relogin     : {'✅ Ativo' if AUTO_RELOGIN_HABILITADO else '⏸️ Desativado'} ({NOTEBOOKLM_PYTHON_EXE} -m notebooklm login)")
    print(f"⚡ Concorrência Máx. : {MAX_CONCORRENCIA_GERACAO} simultâneos (Stagger: {INTERVALO_STAGGER_DISPARO_SEGUNDOS}s)")
    print(f"📋 Ordem de Geração : Semestre (1→8) > Matéria > Aula (1→N) > mindmap→flashcards→quiz→relatorio→infografico→slides→audio→video")
    print(f"🛡️ Auto-Aprovação   : {', '.join(sorted(TIPOS_AUTO_APROVACAO))}")
    print(f"👁️ Revisão Diff A/B : {', '.join(sorted(TIPOS_COM_REVISAO))}")
    print("=" * 72)

    if FASTAPI_DISPONIVEL:
        try:
            import uvicorn  # type: ignore
            uvicorn.run(app, host=HOST_WORKER, port=PORTA_WORKER, log_level="info")
            return
        except ImportError:
            pass

    # Inicia thread do loop do worker e sobe servidor HTTP nativo na porta 8090
    threading.Thread(target=lambda: asyncio.run(loop_worker_background()), daemon=True).start()
    server = ThreadingHTTPServer((HOST_WORKER, PORTA_WORKER), StudioFallbackHTTPHandler)
    print(f"✅ Servidor Studio Worker ativo em http://{HOST_WORKER}:{PORTA_WORKER} (Pressione Ctrl+C para encerrar)")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n⏹️ Encerrando Studio Worker...")
        server.server_close()


if __name__ == "__main__":
    iniciar_servidor()
