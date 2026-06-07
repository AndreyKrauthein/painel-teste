# Guia de Deploy no EasyPanel

Este guia detalha o passo a passo para implantar a API **painel-testes** no **EasyPanel**, garantindo que seus cookies e histórico persistam através de reinicializações do container.

---

## Passo 1: Criar Repositório no GitHub
1. Crie um repositório **privado** (recomendado para segurança) no seu GitHub.
2. Inicialize o Git na sua pasta local e envie o código:
   ```bash
   git init
   git add .
   git commit -m "feat: setup painel-testes api"
   git branch -M main
   git remote add origin git@github.com:seu-usuario/painel-testes.git
   git push -u origin main
   ```
   *(Nota: O arquivo `.gitignore` já está configurado para não enviar a pasta `data/`, o `.env` ou `node_modules` para o GitHub).*

---

## Passo 2: Adicionar um Serviço no EasyPanel
1. Acesse o painel de controle do seu **EasyPanel**.
2. Selecione o seu projeto ou crie um novo.
3. Clique em **+ Service** e escolha a opção **App**.
4. Defina o nome do serviço como `painel-testes`.

---

## Passo 3: Configurar Integração Git/GitHub
1. Na aba **Source** do aplicativo no EasyPanel, selecione **GitHub** (se sua conta estiver conectada) ou **Git** público/privado por SSH.
2. Aponte para o repositório criado (`seu-usuario/painel-testes`) e selecione a branch `main`.

---

## Passo 4: Configurar Build e Start
O EasyPanel usa o **Nixpacks** por padrão, o qual detectará o `package.json` e executará a instalação correta. Se precisar definir manualmente nas configurações de build:
* **Build Command:** `npm install`
* **Start Command:** `npm start`

---

## Passo 5: Adicionar Volume de Persistência (Crítico)
Como a API armazena a sessão (`session.json`), os metadados de status (`session-status.json`) e o histórico de logs (`generated-tests.jsonl`) em arquivos locais, você **DEVE** configurar um volume persistente para que esses dados sobrevivam às reinicializações do container:
1. No menu do aplicativo no EasyPanel, vá para a aba **Mounts** (ou **Volumes**).
2. Adicione um novo volume:
   * **Name/ID:** `painel_testes_data`
   * **Path inside container:** `/app/data` (ou `./data` dependendo do diretório de trabalho, mas `/app/data` é o padrão absoluto no container do EasyPanel).
3. Salve a configuração.

---

## Passo 6: Configurar Variáveis de Ambiente
Na aba **Environment** do EasyPanel, adicione as seguintes variáveis de ambiente:

| Variável | Valor Recomendado / Exemplo | Descrição |
| :--- | :--- | :--- |
| `PORT` | `3000` | Porta interna exposta pelo container. |
| `API_SECRET` | `sua_chave_secreta_segura_aqui` | Chave Bearer usada para proteger as rotas da API. |
| `CMS_BASE_URL` | `https://cms.rboys02.click` | URL do painel IPTV RBOYS. |
| `DEFAULT_PLAN` | `90` | ID do plano padrão (90 equivale a Completo 6 Horas). |
| `N8N_WEBHOOK_URL` | `https://seu-n8n.com/webhook/session-expired` | URL para receber alertas caso a sessão expire. |
| `KEEP_ALIVE_INTERVAL_MINUTES` | `30` | Intervalo em minutos da rotina de Keep Alive. |
| `RATE_LIMIT_MAX` | `60` | Máximo de requisições por janela. |
| `RATE_LIMIT_WINDOW` | `1 minute` | Tempo da janela de rate limit. |
| `MAX_CONCURRENT_GENERATIONS`| `3` | Limite de geração paralela de testes. |

---

## Passo 7: Configurar Domínio e SSL
1. Na aba **Domains** do EasyPanel, associe seu subdomínio à porta `3000` do container (ex: `api-testes.centralcine.com`).
2. O EasyPanel gerará automaticamente o certificado Let's Encrypt SSL para HTTPS.

---

## Passo 8: Deploy e Teste Inicial

1. Clique em **Deploy** no canto superior direito do EasyPanel e aguarde a conclusão do build.
2. **Testar Saúde (Health):**
   Acesse no navegador: `https://api-testes.centralcine.com/health`. O retorno deve ser:
   ```json
   {
     "success": true,
     "service": "painel-testes",
     "status": "online"
   }
   ```
3. **Enviar a primeira Sessão:**
   Faça login manual no painel IPTV, extraia os cookies do navegador (veja as instruções no `README.md`) e faça uma requisição POST para:
   `https://api-testes.centralcine.com/sessao`
   * **Headers:**
     * `Authorization: Bearer <API_SECRET>`
     * `Content-Type: application/json`
   * **Body:**
     ```json
     {
       "cookie": "mundogf_session=...; XSRF-TOKEN=..."
     }
     ```
4. **Verificar Status Administrativo:**
   Chame `GET https://api-testes.centralcine.com/admin/status` com o cabeçalho Bearer para conferir o status de conexão da API.
5. **Testar Geração:**
   Chame `POST https://api-testes.centralcine.com/gerar-teste` com o cabeçalho Bearer para verificar o fluxo completo de geração.
