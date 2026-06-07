# API painel-testes

API Node.js para automatizar a geração de testes IPTV do painel **RBOYS** (`https://cms.rboys02.click`).

O sistema utiliza requisições HTTP puras (sem navegadores headless como Playwright ou Puppeteer e sem dependência do Redis), gerenciando cookies através de um cookie jar persistido localmente e mantendo a sessão viva através de um cron interno.

---

## Sumário
1. [Características principais](#características-principais)
2. [Instalação](#instalação)
3. [Configuração do .env](#configuração-do-env)
4. [Como rodar localmente](#como-rodar-localmente)
5. [Como extrair os cookies do painel](#como-extrair-os-cookies-do-painel)
6. [Endpoints da API](#endpoints-da-api)
   - [Público: GET /health](#get-health)
   - [Protegido: POST /sessao](#post-sessao)
   - [Protegido: GET /sessao/status](#get-sessaostatus)
   - [Protegido: POST /gerar-teste](#post-gerar-teste)
7. [Endpoints Administrativos](#endpoints-administrativos)
   - [Protegido: GET /admin/status](#get-adminstatus)
   - [Protegido: GET /admin/stats](#get-adminstats)
   - [Protegido: POST /admin/refresh-session](#post-adminrefresh-session)
8. [Como testar localmente](#como-testar-localmente)
9. [Agendamento Keep Alive e Webhook n8n](#agendamento-keep-alive-e-webhook-n8n)
10. [Implantação e Guias Adicionais](#implantação-e-guias-adicionais)
    - [Subir no GitHub e EasyPanel](#subir-no-github-e-easypanel)
    - [Domínio e Integração de Frontend](#domínio-e-integração-de-frontend)
11. [Sobre o login automático e reCAPTCHA](#sobre-o-login-automático-e-recaptcha)

---

## Características principais
* **Segurança de Logs:** Toda a aplicação utiliza o `safeLogger` para garantir que cookies, tokens de sessão, credenciais geradas de IPTV e o segredo `API_SECRET` nunca vazem no console.
* **Keep-Alive e Redirecionamento Automático:** Interceptadores de requisição Axios salvam novos cookies fornecidos nas respostas (`Set-Cookie`) automaticamente.
* **Controle de Concorrência em Memória:** Limita o número de conexões simultâneas de geração baseado na variável `MAX_CONCURRENT_GENERATIONS` sem exigir Redis.
* **Rate Limiter Integrado:** Proteção nativa por IP contra abusos.
* **Fallback Seguro:** Caso ocorra algum erro inesperado na geração, a API responde com um payload padronizado direcionando o usuário para o suporte via WhatsApp.

---

## Instalação

Certifique-se de ter o **Node.js (versão 18 ou superior)** instalado em sua máquina.

1. Navegue até o diretório do projeto:
   ```bash
   cd painel-testes
   ```

2. Instale as dependências:
   ```bash
   npm install
   ```

---

## Configuração do .env

Crie o arquivo `.env` na raiz do projeto (copie o modelo de `.env.example`):
```bash
cp .env.example .env
```

Edite as seguintes variáveis no seu `.env`:

* `PORT`: Porta onde a API vai escutar (padrão `3000`).
* `API_SECRET`: Token de autenticação Bearer para rotas protegidas (defina uma chave segura!).
* `CMS_BASE_URL`: URL base do painel (padrão `https://cms.rboys02.click`).
* `DEFAULT_PLAN`: ID do plano padrão caso não seja fornecido na requisição (padrão `90` = COMPLETO 6H).
* `N8N_WEBHOOK_URL`: URL do webhook do n8n para alertar sobre sessão expirada.
* `KEEP_ALIVE_INTERVAL_MINUTES`: Intervalo do cron em minutos para manter a sessão viva (padrão `30`).
* `RATE_LIMIT_MAX`: Máximo de requisições permitidas por janela de rate limit (padrão `60`).
* `RATE_LIMIT_WINDOW`: Janela de tempo do rate limit (padrão `1 minute`).
* `MAX_CONCURRENT_GENERATIONS`: Máximo de requisições de geração simultâneas em memória (padrão `3`).

---

## Como rodar localmente

* **Modo Desenvolvimento (com auto-reload):**
  ```bash
  npm run dev
  ```
* **Modo Produção:**
  ```bash
  npm start
  ```

---

## Como extrair os cookies do painel

Como a API não realiza o login automático devido ao reCAPTCHA invisível, é necessário capturar os cookies de uma sessão ativa em seu navegador e enviá-los para o endpoint `/sessao` ou `/admin/refresh-session`.

### Pelo Computador (Google Chrome, Firefox, Edge):
1. Acesse o painel `https://cms.rboys02.click` e faça login normalmente na sua conta de revendedor.
2. Pressione a tecla **F12** para abrir as Ferramentas do Desenvolvedor e vá para a aba **Console**.
3. Digite o seguinte comando e aperte **Enter**:
   ```javascript
   document.cookie
   ```
4. Copie a saída retornada (por exemplo: `XSRF-TOKEN=eyJ...; mundogf_session=ey...`). Ela conterá ambos os cookies necessários.

### Pelo Celular Android (Usando Kiwi Browser):
1. Instale o **Kiwi Browser** na Google Play Store.
2. Acesse `https://cms.rboys02.click`, faça login na sua conta.
3. Abra o console do desenvolvedor no Kiwi, digite `document.cookie` e copie o resultado.

---

## Endpoints da API

Todas as rotas protegidas exigem o cabeçalho:
`Authorization: Bearer <API_SECRET>`

### GET /health
Endpoint público para verificação de status da API.
* **Exemplo de Retorno:**
  ```json
  {
    "success": true,
    "service": "painel-testes",
    "status": "online"
  }
  ```

### POST /sessao
Define e valida a sessão enviando os cookies capturados do navegador.
* **Corpo da requisição (JSON):**
  ```json
  {
    "cookie": "XSRF-TOKEN=seu_xsrf_token; mundogf_session=sua_sessao"
  }
  ```
* **Exemplo de Retorno:**
  ```json
  {
    "success": true,
    "message": "Sessão atualizada com sucesso",
    "ativa": true
  }
  ```

### GET /sessao/status
Verifica se a sessão atualmente salva no servidor está ativa no painel IPTV.
* **Exemplo de Retorno (Sessão Ativa):**
  ```json
  {
    "success": true,
    "ativa": true
  }
  ```

### POST /gerar-teste
Gera um novo teste IPTV no painel e retorna os dados de conexão limpos.
* **Corpo da requisição (JSON - Opcional):**
  ```json
  {
    "telefone": "48999999999",
    "plano": 90,
    "notes": "Teste Central Cine"
  }
  ```
  * *Planos mapeados:*
    * `93` = COMPLETO - TESTE 1 HORA
    * `89` = COMPLETO - TESTE 3 HORAS
    * `90` = COMPLETO - TESTE 6 HORAS (Padrão)
    * `91` = COMPLETO SEM ADULTO - TESTE 3 HORAS
    * `92` = COMPLETO SEM ADULTO - TESTE 6 HORAS
* **Exemplo de Retorno (Sucesso):**
  ```json
  {
    "success": true,
    "data": {
      "usuario": "teste123",
      "senha": "senha_gerada",
      "url": "http://servidor.click",
      "codigo": "RBOYS",
      "vencimento": "06/06/2026 09:30",
      "link_lista": "http://servidor.click:80/get.php?username=teste123&password=senha_gerada&output=ts",
      "link_padrao": "http://servidor.click:80/get.php?username=teste123&password=senha_gerada&output=ts",
      "link_ssiptv": "http://servidor.click:80/get.php?username=teste123&password=senha_gerada&output=ts",
      "epg": "http://servidor.click:80/xmltv.php?username=teste123&password=senha_gerada"
    }
  }
  ```

---

## Endpoints Administrativos

### GET /admin/status
Consulta a saúde geral da sessão, checks históricos, uptime da API e quantidade de testes gerados.
* **Exemplo de Retorno:**
  ```json
  {
    "success": true,
    "service": "painel-testes",
    "sessionActive": true,
    "lastSessionCheck": "2026-06-06T03:00:00.000Z",
    "lastSessionSuccess": "2026-06-06T03:00:00.000Z",
    "lastSessionError": "2026-06-06T01:30:00.000Z",
    "lastGeneratedTestAt": "2026-06-06T03:15:00.000Z",
    "generatedToday": 14,
    "generatedTotal": 128,
    "uptime": "1d 2h 15m 4s"
  }
  ```

### GET /admin/stats
Consulta a quantidade de testes gerados agrupados por período de tempo.
* **Exemplo de Retorno:**
  ```json
  {
    "success": true,
    "stats": {
      "today": 14,
      "yesterday": 25,
      "last7Days": 85,
      "thisMonth": 128,
      "total": 128
    }
  }
  ```

### POST /admin/refresh-session
Reaproveita a lógica de `/sessao` para atualizar manualmente os cookies.
* **Corpo da requisição (JSON):**
  ```json
  {
    "cookie": "XSRF-TOKEN=seu_xsrf_token; mundogf_session=sua_sessao"
  }
  ```

---

## Como testar localmente

Com a API iniciada na porta `3000` e `API_SECRET=troque_essa_chave`:

1. **Checar saúde da API:**
   ```bash
   curl -X GET http://localhost:3000/health
   ```
2. **Atualizar a Sessão de Cookies:**
   ```bash
   curl -X POST http://localhost:3000/sessao \
     -H "Authorization: Bearer troque_essa_chave" \
     -H "Content-Type: application/json" \
     -d '{"cookie": "XSRF-TOKEN=seu_cookie_token; mundogf_session=seu_cookie_session"}'
   ```
3. **Checar Status Administrativo:**
   ```bash
   curl -X GET http://localhost:3000/admin/status \
     -H "Authorization: Bearer troque_essa_chave"
   ```
4. **Checar Estatísticas de Geração:**
   ```bash
   curl -X GET http://localhost:3000/admin/stats \
     -H "Authorization: Bearer troque_essa_chave"
   ```
5. **Gerar Teste IPTV:**
   ```bash
   curl -X POST http://localhost:3000/gerar-teste \
     -H "Authorization: Bearer troque_essa_chave" \
     -H "Content-Type: application/json" \
     -d '{"telefone": "48999999999", "plano": 90}'
   ```

---

## Agendamento Keep Alive e Webhook n8n

O servidor executa automaticamente uma tarefa a cada `KEEP_ALIVE_INTERVAL_MINUTES` minutos. Se ela detectar que a sessão expirou, fará uma chamada do tipo **POST** para o seu `N8N_WEBHOOK_URL` configurado:
```json
{
  "tipo": "sessao_expirada",
  "servico": "painel-testes",
  "mensagem": "A sessão do painel RBOYS expirou. Atualize os cookies.",
  "timestamp": "2026-06-06T03:00:00.000Z"
}
```
* **Evitando Spam:** O webhook será acionado no máximo 1 vez a cada 2 horas caso a sessão continue expirada.

---

## Implantação e Guias Adicionais

### Subir no GitHub e EasyPanel
Para um guia detalhado sobre build, start, persistência de volume para `/app/data` (indispensável para não perder a sessão ao reiniciar o container) e injeção de variáveis de ambiente no EasyPanel, leia:
* **[Guia de Deploy no EasyPanel (docs/DEPLOY_EASYPANEL.md)](file:///c:/Users/andre/OneDrive/Área%20de%20Trabalho/Projetos/Ecosistema%20Central%20Cine/painel-teste/docs/DEPLOY_EASYPANEL.md)**

### Domínio e Integração de Frontend
Para configurar e integrar a API ao frontend do site Central Cine com o tratamento correto de erros e ações de fallback (`fallback_whatsapp`, `session_expired` e `try_again`), leia:
* **[Guia de Integração de Frontend (docs/FRONTEND_INTEGRATION.md)](file:///c:/Users/andre/OneDrive/Área%20de%20Trabalho/Projetos/Ecosistema%20Central%20Cine/painel-teste/docs/FRONTEND_INTEGRATION.md)**

---

## Sobre o login automático e reCAPTCHA

O painel da RBOYS IPTV implementa o **reCAPTCHA invisível do Google** no formulário de login. Por essa razão, optou-se pela estratégia híbrida: o login é feito manualmente pelo navegador uma única vez, e a API mantém os cookies salvos em atividade permanente.
