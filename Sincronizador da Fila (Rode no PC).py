import os
import sys
import time
import json
import urllib.request
import urllib.error

# Garante suporte a UTF-8/emojis no terminal Windows
if sys.platform == "win32":
    try:
        sys.stdout.reconfigure(encoding="utf-8")
        sys.stderr.reconfigure(encoding="utf-8")
    except Exception:
        pass

# ==============================================================================
# ⚙️ CONFIGURAÇÃO
# ==============================================================================
FIREBASE_URL = "https://study-os-fcc4a-default-rtdb.firebaseio.com"

# Tenta obter o FIREBASE_SECRET a partir de variável de ambiente ou de notion_config.json
FIREBASE_SECRET = os.environ.get("FIREBASE_SECRET", "")
if not FIREBASE_SECRET:
    try:
        script_dir = os.path.dirname(os.path.abspath(__file__))
        cfg_path = os.path.join(script_dir, "notion_config.json")
        if os.path.exists(cfg_path):
            with open(cfg_path, "r", encoding="utf-8") as f:
                cfg_data = json.load(f)
                FIREBASE_SECRET = cfg_data.get("firebase_secret", "")
    except Exception:
        pass


def firebase_url_auth(path: str) -> str:
    """Retorna URL formatada com autenticação ?auth=SECRET para o Firebase RTDB."""
    base = f"{FIREBASE_URL.rstrip('/')}/{path.lstrip('/')}"
    if FIREBASE_SECRET:
        sep = "&" if "?" in base else "?"
        return f"{base}{sep}auth={FIREBASE_SECRET}"
    return base


# Caminho base do seu Google Drive no PC
BASE_DIR = r"G:\Meu Drive\CienciaComputacao"

# Importa motor do Notion para sincronização bidirecional
try:
    script_dir = os.path.dirname(os.path.abspath(__file__))
    if script_dir not in sys.path:
        sys.path.insert(0, script_dir)
    import sincronizador_notion as sn
    NOTION_DISPONIVEL = True
except Exception as e:
    sn = None
    NOTION_DISPONIVEL = False
    print(f"⚠️ Módulo sincronizador_notion não carregado: {e}")


def normalizar_caminho(caminho):
    return str(caminho or "").replace('\\', '/').strip('/').lower()


def buscar_no_por_caminho(node, target_path_norm, path_indices=None):
    if path_indices is None:
        path_indices = []
    local_norm = normalizar_caminho(node.get("local"))
    if local_norm and local_norm == target_path_norm:
        return path_indices, node
    for idx, c in enumerate(node.get("filhos", [])):
        res = buscar_no_por_caminho(c, target_path_norm, path_indices + [idx])
        if res:
            return res
    return None


def buscar_materia_por_nome(db_root, nome_materia):
    """Encontra o nó de uma matéria no db.json dinamicamente por Match Inteligente."""
    if not db_root or not nome_materia:
        return None

    if NOTION_DISPONIVEL and sn:
        materias = sn.extrair_todas_materias_db(db_root)
        casado = sn.casar_materia_notion_com_db({"nome": nome_materia}, materias)
        if casado:
            return casado["node"]

    # Fallback recursivo por normalização de texto
    alvo_norm = normalizar_caminho(nome_materia)
    def varrer(node):
        if normalizar_caminho(node.get("nome", "")) == alvo_norm:
            return node
        for f in node.get("filhos", []):
            if f.get("tipo") == "pasta":
                res = varrer(f)
                if res:
                    return res
        return None
    return varrer(db_root)


def firebase_put(caminho: str, dados) -> bool:
    """Envia nó para o Firebase RTDB via PUT com autenticação."""
    url = firebase_url_auth(f"{caminho.strip('/')}.json")
    body = json.dumps(dados, ensure_ascii=False).encode("utf-8")
    req = urllib.request.Request(url, data=body, headers={"Content-Type": "application/json"}, method="PUT")
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            return resp.status in (200, 204)
    except Exception as e:
        print(f"   ⚠️ Falha ao atualizar Firebase ({caminho}): {e}")
        return False


def processar_fila():
    print(f"🔍 Conectando à Fila do Firebase ({FIREBASE_URL})...")
    try:
        # Puxa toda a fila de edições via REST API
        req_get = urllib.request.Request(firebase_url_auth("fila_md.json"), headers={"User-Agent": "StudyOS-Sync/2.0"})
        with urllib.request.urlopen(req_get, timeout=30) as resp:
            raw_data = resp.read().decode("utf-8")
            fila = json.loads(raw_data) if raw_data else None

        if not fila:
            print("✨ Nenhuma edição pendente na fila.")
            return

        # Carrega db.json local se existir
        script_dir = os.path.dirname(os.path.abspath(__file__))
        db_path = os.path.join(script_dir, "db.json")
        db_local = None
        db_modificado = False
        if os.path.exists(db_path):
            try:
                with open(db_path, "r", encoding="utf-8") as f:
                    db_local = json.load(f)
            except Exception as e:
                print(f"⚠️ Não foi possível carregar db.json local: {e}")

        # Ordena pela mais antiga primeiro (timestamp)
        itens = sorted(fila.items(), key=lambda x: x[1].get('timestamp', 0))
        print(f"📦 Encontradas {len(itens)} operações na fila. Processando...\n")

        token_notion = sn.obter_notion_token() if (NOTION_DISPONIVEL and sn) else ""

        for key, data in itens:
            tipo = data.get("tipo", "edicao_md_aula")

            # ==================================================================
            # 1. EDIÇÃO DE DATA, PRESENÇA E REVISÃO DA AULA (CONTROLE DE AULAS)
            # ==================================================================
            if tipo in ("edicao_aula_data", "edicao_aula_status"):
                nome_materia = data.get("nome_materia", "")
                num_aula = data.get("num_aula")
                nova_data = data.get("nova_data")
                presenca = data.get("presenca")
                revisao = data.get("revisao")
                print(f"⏳ [Aula] Atualizando Aula {num_aula} de '{nome_materia}' (Data: {nova_data}, Presença: {presenca}, Revisão: {revisao})...")

                if db_local:
                    node_mat = buscar_materia_por_nome(db_local, nome_materia)
                    if node_mat:
                        for f in node_mat.get("filhos", []):
                            if f.get("tipo") == "pasta" and sn and sn.extrair_numero_aula(f.get("nome")) == num_aula:
                                if nova_data is not None:
                                    f["data_aula"] = nova_data
                                if presenca is not None:
                                    f["presenca"] = bool(presenca)
                                if revisao is not None:
                                    f["revisao"] = bool(revisao)
                                db_modificado = True
                                print(f"   ✅ Metadados da aula (Data/Presença/Revisão) atualizados no db.json local!")
                                break

                if token_notion:
                    try:
                        cursos = sn.notion_request(f"databases/{sn.ID_DATABASE_CURSOS}/query", method="POST", payload={"page_size": 100}, token=token_notion).get("results", [])
                        cid = None
                        for p in cursos:
                            p_nome = "".join(x.get("plain_text", "") for x in p.get("properties", {}).get("Nome", {}).get("title", []))
                            if sn.normalizar_texto(p_nome) == sn.normalizar_texto(nome_materia):
                                cid = p["id"]
                                break
                        if cid:
                            filtro = {"and": [{"property": "📒Cursos", "relation": {"contains": cid}}]}
                            aulas_res = sn.notion_request(f"databases/{sn.ID_DATABASE_CONTROLE_AULAS}/query", method="POST", payload={"filter": filtro, "page_size": 100}, token=token_notion).get("results", [])
                            for p_aula in aulas_res:
                                tit = "".join(x.get("plain_text", "") for x in p_aula.get("properties", {}).get("Capítulo e Matéria", {}).get("title", []))
                                if sn.extrair_numero_aula(tit) == num_aula:
                                    props_aula = {}
                                    if nova_data is not None:
                                        props_aula["Date"] = {"date": {"start": nova_data}} if nova_data else {"date": None}
                                    if presenca is not None:
                                        props_aula["Presença"] = {"checkbox": bool(presenca)}
                                    if revisao is not None:
                                        props_aula["Revisão de aula"] = {"checkbox": bool(revisao)}
                                    if props_aula:
                                        sn.notion_atualizar_pagina(p_aula["id"], propriedades=props_aula, token=token_notion)
                                        print(f"   ✅ Propriedades atualizadas no Notion (Controle de Aulas: {list(props_aula.keys())})!")
                                    break
                    except Exception as e_notion:
                        print(f"   ⚠️ Falha ao atualizar aula no Notion: {e_notion}")

            # ==================================================================
            # 2. EDIÇÃO DE METADADOS DA MATÉRIA (NOME, PROF, STATUS, TAGS, BANNER)
            # ==================================================================
            elif tipo == "edicao_materia":
                nome_antigo = data.get("nome_antigo", "")
                novo_nome = data.get("novo_nome", nome_antigo)
                novo_icone = data.get("novo_icone", "")
                novo_prof = data.get("novo_prof", "")
                novo_status = data.get("novo_status", "")
                novas_tags = data.get("novas_tags")
                novo_cover = data.get("novo_cover", "")
                print(f"⏳ [Matéria] Atualizando '{nome_antigo}' ➔ '{novo_nome}'...")

                if db_local:
                    node_mat = buscar_materia_por_nome(db_local, nome_antigo)
                    if node_mat:
                        if novo_nome:
                            node_mat["nome"] = novo_nome
                        if novo_prof:
                            node_mat["prof"] = novo_prof
                        if novo_status:
                            node_mat["Status"] = novo_status
                            node_mat["status"] = novo_status.lower()
                        if novas_tags is not None:
                            node_mat["tags"] = novas_tags
                        if novo_cover is not None:
                            node_mat["cover"] = novo_cover
                        db_modificado = True
                        print(f"   ✅ Metadados da matéria atualizados no db.json local!")

                if token_notion:
                    try:
                        cursos = sn.notion_request(f"databases/{sn.ID_DATABASE_CURSOS}/query", method="POST", payload={"page_size": 100}, token=token_notion).get("results", [])
                        curso_alvo = None
                        for p in cursos:
                            p_nome = "".join(x.get("plain_text", "") for x in p.get("properties", {}).get("Nome", {}).get("title", []))
                            if sn.normalizar_texto(p_nome) == sn.normalizar_texto(nome_antigo):
                                curso_alvo = p
                                break
                        if curso_alvo:
                            props = {}
                            if novo_nome:
                                props["Nome"] = {"title": [{"type": "text", "text": {"content": novo_nome}}]}
                            if novo_prof:
                                props["Prof"] = {"rich_text": [{"type": "text", "text": {"content": novo_prof}}]}
                            if novo_status:
                                props["Status"] = {"status": {"name": novo_status}}
                            if novas_tags is not None:
                                props["Ano"] = {"multi_select": [{"name": t} for t in novas_tags]}

                            sn.notion_atualizar_pagina(
                                curso_alvo["id"],
                                propriedades=props if props else None,
                                cover_url=novo_cover if novo_cover else None,
                                icon_emoji=novo_icone if novo_icone else None,
                                token=token_notion
                            )
                            print(f"   ✅ Matéria atualizada no Notion com sucesso!")
                    except Exception as e_mat_notion:
                        print(f"   ⚠️ Falha ao atualizar matéria no Notion: {e_mat_notion}")

            # ==================================================================
            # 3. EDIÇÃO DE ATIVIDADE VALENDO NOTA
            # ==================================================================
            elif tipo == "edicao_atividade":
                nome_materia = data.get("nome_materia", "")
                nome_antigo = data.get("nome_antigo", "")
                dados_ativ = data.get("atividade", {})
                print(f"⏳ [Atividade] Atualizando '{nome_antigo}' de '{nome_materia}'...")

                if db_local:
                    node_mat = buscar_materia_por_nome(db_local, nome_materia)
                    if node_mat:
                        atividades = node_mat.get("atividades", [])
                        achou = False
                        for a in atividades:
                            if sn.normalizar_texto(a.get("nome", "")) == sn.normalizar_texto(nome_antigo):
                                a["nome"] = dados_ativ.get("nome", a.get("nome"))
                                a["status"] = dados_ativ.get("status", a.get("status"))
                                a["tipo"] = dados_ativ.get("tipo", a.get("tipo"))
                                a["avaliacao"] = dados_ativ.get("avaliacao", a.get("avaliacao"))
                                a["nota_obtida"] = float(dados_ativ.get("nota_obtida", a.get("nota_obtida", 0)))
                                a["nota_maxima"] = float(dados_ativ.get("nota_maxima", a.get("nota_maxima", 0)))
                                a["data"] = dados_ativ.get("data", a.get("data"))
                                if "corpo_md" in dados_ativ:
                                    a["corpo_md"] = dados_ativ["corpo_md"]
                                achou = True
                                break
                        if not achou:
                            atividades.append({
                                "nome": dados_ativ.get("nome", "Nova Atividade"),
                                "status": dados_ativ.get("status", "A fazer"),
                                "tipo": dados_ativ.get("tipo", "Atividade"),
                                "avaliacao": dados_ativ.get("avaliacao", "A1"),
                                "nota_obtida": float(dados_ativ.get("nota_obtida", 0)),
                                "nota_maxima": float(dados_ativ.get("nota_maxima", 0)),
                                "data": dados_ativ.get("data", ""),
                                "corpo_md": dados_ativ.get("corpo_md", "")
                            })
                            node_mat["atividades"] = atividades
                        db_modificado = True
                        print(f"   ✅ Atividade atualizada no db.json local!")

                if token_notion:
                    try:
                        cursos = sn.notion_request(f"databases/{sn.ID_DATABASE_CURSOS}/query", method="POST", payload={"page_size": 100}, token=token_notion).get("results", [])
                        cid = None
                        for p in cursos:
                            p_nome = "".join(x.get("plain_text", "") for x in p.get("properties", {}).get("Nome", {}).get("title", []))
                            if sn.normalizar_texto(p_nome) == sn.normalizar_texto(nome_materia):
                                cid = p["id"]
                                break
                        if cid:
                            filtro = {"and": [{"property": "Materia", "relation": {"contains": cid}}]}
                            notas_res = sn.notion_request(f"databases/{sn.ID_DATABASE_NOTAS}/query", method="POST", payload={"filter": filtro, "page_size": 100}, token=token_notion).get("results", [])
                            nota_alvo = None
                            for p_nota in notas_res:
                                n_tit = "".join(x.get("plain_text", "") for x in p_nota.get("properties", {}).get("Name", {}).get("title", []))
                                if sn.normalizar_texto(n_tit) == sn.normalizar_texto(nome_antigo):
                                    nota_alvo = p_nota
                                    break

                            props = {
                                "Name": {"title": [{"type": "text", "text": {"content": dados_ativ.get("nome", nome_antigo)}}]},
                                "Status": {"status": {"name": dados_ativ.get("status", "A fazer")}},
                                "Tipo": {"select": {"name": dados_ativ.get("tipo", "Atividade")}},
                                "A": {"select": {"name": dados_ativ.get("avaliacao", "A1")}},
                                "Nota obtida": {"number": float(dados_ativ.get("nota_obtida", 0))},
                                "Nota maxima": {"number": float(dados_ativ.get("nota_maxima", 0))},
                            }
                            if dados_ativ.get("data"):
                                props["Data"] = {"date": {"start": dados_ativ["data"]}}
                            else:
                                props["Data"] = {"date": None}

                            if nota_alvo:
                                sn.notion_atualizar_pagina(nota_alvo["id"], propriedades=props, token=token_notion)
                                if dados_ativ.get("corpo_md"):
                                    sn.notion_limpar_filhos_bloco(nota_alvo["id"], token=token_notion)
                                    blocos = sn.markdown_para_blocos_notion(dados_ativ["corpo_md"])
                                    if blocos:
                                        sn.notion_anexar_blocos(nota_alvo["id"], blocos, token=token_notion)
                                print(f"   ✅ Atividade atualizada no banco Notas do Notion!")
                            else:
                                props["Materia"] = {"relation": [{"id": cid}]}
                                nova_p = sn.notion_criar_pagina(sn.ID_DATABASE_NOTAS, props, token=token_notion)
                                if nova_p.get("id") and dados_ativ.get("corpo_md"):
                                    blocos = sn.markdown_para_blocos_notion(dados_ativ["corpo_md"])
                                    if blocos:
                                        sn.notion_anexar_blocos(nova_p["id"], blocos, token=token_notion)
                                print(f"   ✅ Nova atividade criada no banco Notas do Notion!")
                    except Exception as e_ativ_notion:
                        print(f"   ⚠️ Falha ao atualizar atividade no Notion: {e_ativ_notion}")

            # ==================================================================
            # 4. EDIÇÃO DE MARKDOWN DA AULA (COM PRESERVAÇÃO SAGRADA DAS MÍDIAS)
            # ==================================================================
            else:
                local_path = data.get('localPath', '')
                novo_texto = data.get('novoTexto', '')

                # Corrige as barras do caminho para rodar perfeitamente no Windows
                caminho_windows = local_path.replace('/', '\\').lstrip('\\')
                full_path = os.path.join(BASE_DIR, caminho_windows)

                print(f"⏳ [Markdown] Atualizando arquivo: {local_path}")

                # 1. Abre e sobrescreve o arquivo físico no disco local (Google Drive)
                if os.path.exists(full_path):
                    with open(full_path, 'w', encoding='utf-8-sig') as f:
                        f.write(novo_texto)
                    print(f"   ✅ Arquivo local modificado com sucesso (Google Drive fará upload)!")
                else:
                    print(f"   ⚠️ ARQUIVO NÃO ENCONTRADO NO DISCO: {full_path}")

                # 2. Atualiza o nó correspondente no db.json local e na nuvem do Firebase
                pasta_aula_node = None
                nome_materia_detectada = ""
                if db_local:
                    target_norm = normalizar_caminho(local_path)
                    busca = buscar_no_por_caminho(db_local, target_norm)
                    if busca:
                        indices, node_alvo = busca
                        node_alvo["conteudoTexto"] = novo_texto
                        db_modificado = True

                        # Localiza a pasta pai da aula no db_local
                        try:
                            pasta_idx = indices[:-1]
                            curr = db_local
                            for ix in pasta_idx:
                                curr = curr.get("filhos", [])[ix]
                            pasta_aula_node = curr

                            # Pega a matéria pai
                            mat_idx = indices[:-2]
                            curr_mat = db_local
                            for ix in mat_idx:
                                curr_mat = curr_mat.get("filhos", [])[ix]
                            nome_materia_detectada = curr_mat.get("nome", "")
                        except Exception:
                            pass

                        # Atualiza pontualmente na nuvem do Firebase
                        try:
                            partes = ["db_json"]
                            for idx in indices:
                                partes.extend(["filhos", str(idx)])
                            partes.append("conteudoTexto.json")
                            url_fb_node = firebase_url_auth(f"{'/'.join(partes)}")

                            req_put = urllib.request.Request(
                                url_fb_node,
                                data=json.dumps(novo_texto).encode("utf-8"),
                                headers={"Content-Type": "application/json"},
                                method="PUT"
                            )
                            with urllib.request.urlopen(req_put, timeout=20) as patch_resp:
                                if patch_resp.status == 200:
                                    print(f"   ☁️ Atualizado no Firebase (/db_json) com sucesso!")
                        except Exception as fb_err:
                            print(f"   ⚠️ Falha ao atualizar nó no Firebase: {fb_err}")

                # 3. Atualiza o Synced Block no Notion PRESERVANDO RIGOROSAMENTE AS MÍDIAS DO DRIVE
                if token_notion and pasta_aula_node and nome_materia_detectada:
                    try:
                        num_aula = sn.extrair_numero_aula(pasta_aula_node.get("nome", ""))
                        if num_aula is not None:
                            cursos = sn.notion_request(f"databases/{sn.ID_DATABASE_CURSOS}/query", method="POST", payload={"page_size": 100}, token=token_notion).get("results", [])
                            cid = None
                            for p in cursos:
                                p_nome = "".join(x.get("plain_text", "") for x in p.get("properties", {}).get("Nome", {}).get("title", []))
                                if sn.normalizar_texto(p_nome) == sn.normalizar_texto(nome_materia_detectada):
                                    cid = p["id"]
                                    break
                            if cid:
                                original_synced_id = sn.obter_ou_criar_synced_block_original(cid, num_aula, token=token_notion)
                                if original_synced_id:
                                    # Limpa blocos existentes e reinjeta Markdown + 5 Mídias do Drive sagradas!
                                    sn.notion_limpar_filhos_bloco(original_synced_id, token=token_notion)
                                    sn.replicar_arquivos_no_synced_block(original_synced_id, pasta_aula_node, token=token_notion)
                                    print(f"   ✨ Synced Block no Notion atualizado mantendo mídias do Drive!")
                    except Exception as e_notion_sync:
                        print(f"   ⚠️ Falha ao atualizar Synced Block no Notion: {e_notion_sync}")

            # 4. Exclui a tarefa processada da fila do Firebase
            del_req = urllib.request.Request(firebase_url_auth(f"fila_md/{key}.json"), method="DELETE")
            try:
                with urllib.request.urlopen(del_req, timeout=30) as del_resp:
                    if del_resp.status in (200, 204):
                        print(f"   🗑️ Removido da fila.\n")
                    else:
                        print(f"   ❌ Falha ao limpar a fila! (HTTP {del_resp.status})\n")
            except Exception as del_err:
                print(f"   ❌ Falha ao excluir item da fila: {del_err}\n")

        # Salva o db.json local com as alterações aplicadas
        if db_modificado and db_local:
            try:
                with open(db_path, "w", encoding="utf-8") as f:
                    json.dump(db_local, f, ensure_ascii=False, indent=2)
                print("💾 db.json local atualizado e sincronizado!")
            except Exception as e:
                print(f"⚠️ Erro ao salvar db.json local: {e}")

            # Atualiza o /db_json no Firebase
            print("☁️ Atualizando /db_json na nuvem do Firebase...")
            firebase_put("db_json", db_local)

        print("🎉 Sincronização 100% concluída!")

    except Exception as e:
        print(f"❌ Erro na execução: {e}")


if __name__ == "__main__":
    print("=" * 65)
    print("🔄 SINCRONIZADOR UNIFICADO DA FILA STUDY OS + NOTION (PC)")
    print("=" * 65)
    processar_fila()
    print("\nFechando em 5 segundos...")
    time.sleep(5)
