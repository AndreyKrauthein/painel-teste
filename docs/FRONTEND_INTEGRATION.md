# Integração de Frontend - Central Cine

Este guia explica como o site **Central Cine** (ou outros clientes frontend) deve consumir a API **painel-testes** para gerar contas de teste IPTV de forma dinâmica.

---

## Estrutura da Chamada de Integração

O frontend deve fazer uma requisição do tipo **POST** para o endpoint `/gerar-teste`.

### Requisição HTTP
* **Endpoint:** `POST https://sua-api.com/gerar-teste`
* **Headers:**
  * `Authorization: Bearer <API_SECRET>`
  * `Content-Type: application/json`
* **Body (Opcional):**
  ```json
  {
    "telefone": "48999999999",
    "plano": 90,
    "notes": "Gerado via Site Central Cine"
  }
  ```

---

## Estrutura de Respostas da API

O frontend deve estar preparado para tratar os seguintes cenários de retorno da API:

### 1. Geração com Sucesso (Status HTTP 200)
A conta foi criada no painel e as credenciais foram extraídas e estruturadas com sucesso.
* **Payload:**
  ```json
  {
    "success": true,
    "data": {
      "usuario": "91044875",
      "senha": "senha_gerada_123",
      "url": "http://servidor.click",
      "codigo": "RBOYS",
      "vencimento": "06/06/2026 09:30",
      "link_lista": "http://servidor.click:80/get.php?username=91044875&password=senha_gerada_123&output=ts",
      "link_padrao": "http://servidor.click:80/get.php?username=91044875&password=senha_gerada_123&output=ts",
      "link_ssiptv": "http://servidor.click:80/get.php?username=91044875&password=senha_gerada_123&output=ts",
      "epg": "http://servidor.click:80/xmltv.php?username=91044875&password=senha_gerada_123"
    }
  }
  ```
* **Ação Recomendada no Frontend:** Apresentar as credenciais na tela (Usuário, Senha, URL de Login) e fornecer botões fáceis para "Copiar Link de Lista" ou "Copiar URL da Lista".

---

### 2. Tratamento de Erros e Fallbacks

A API retorna sempre o mesmo padrão de erro contendo um atributo `action` para guiar o comportamento do frontend.

#### Cenário A: Sessão Expirada (Status HTTP 400)
Os cookies do painel de administração expiraram. A API não consegue autenticar para gerar o teste e disparou uma notificação silenciosa para o n8n para que o administrador atualize.
* **Payload:**
  ```json
  {
    "success": false,
    "error": "Sessão expirada. Atualize a sessão.",
    "action": "session_expired"
  }
  ```
* **Ação Recomendada no Frontend:** Redirecionar o fluxo do usuário para a geração manual ou contingência via WhatsApp. 
  * *Exemplo:* Exibir um botão: *"Gerar no WhatsApp"* que abre uma conversa com o suporte com uma mensagem pronta: *"Olá, tentei gerar um teste no site mas a sessão expirou. Pode me mandar um teste?"*

#### Cenário B: Erro Interno / Falha no Painel (Status HTTP 500)
Ocorreu algum erro na requisição ao painel, mudança temporária no HTML ou limite de cotas diárias de teste atingido.
* **Payload:**
  ```json
  {
    "success": false,
    "error": "Não foi possível gerar o teste agora.",
    "action": "fallback_whatsapp"
  }
  ```
* **Ação Recomendada no Frontend:** Redirecionar o usuário diretamente para o suporte via WhatsApp.
  * *Exemplo:* Redirecionar automaticamente para: `https://wa.me/55NUMERO_SUPORTE?text=Olá,%20gostaria%20de%20solicitar%20um%20teste%20IPTV.`

#### Cenário C: Limite de Concorrência ou Rate Limit (Status HTTP 429)
Muitas pessoas tentando gerar testes ao mesmo tempo na API ou limite de requisições por IP excedido.
* **Payload:**
  ```json
  {
    "success": false,
    "error": "Muitas solicitações no momento. Tente novamente em alguns segundos.",
    "action": "try_again"
  }
  ```
* **Ação Recomendada no Frontend:** Exibir uma mensagem amigável solicitando que o usuário aguarde alguns segundos e clique novamente no botão de geração.

---

## Exemplo Prático de Implementação (JavaScript - Fetch API)

```javascript
async function requestIptvTest(phoneNumber, planId = 90) {
  const API_URL = 'https://api-testes.centralcine.com/gerar-teste';
  const API_SECRET = 'sua_chave_secreta_segura_aqui';

  try {
    const response = await fetch(API_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${API_SECRET}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        telefone: phoneNumber,
        plano: planId,
        notes: 'Gerado via Site Central Cine'
      })
    });

    const result = await response.json();

    if (result.success) {
      // Exibe os dados de login e links na tela do usuário
      showTestCredentials(result.data);
    } else {
      // Trata as ações de fallback com base no payload
      handleErrorFallback(result);
    }
  } catch (error) {
    // Erros graves de conexão
    console.error('Erro de rede ao conectar à API de testes:', error);
    redirectToWhatsApp();
  }
}

function handleErrorFallback(result) {
  const supportPhone = '5548999999999'; // Seu telefone do suporte
  
  if (result.action === 'session_expired' || result.action === 'fallback_whatsapp') {
    alert('Estamos com alta demanda de testes automáticos. Você será redirecionado para o nosso suporte no WhatsApp para receber seu teste imediatamente.');
    window.location.href = `https://wa.me/${supportPhone}?text=Olá,%20gostaria%20de%20receber%20um%20teste%20IPTV%20(Erro%20API)`;
  } else if (result.action === 'try_again') {
    alert('Muitos testes sendo gerados ao mesmo tempo. Por favor, aguarde 5 segundos e tente novamente.');
  } else {
    // Outros erros genéricos
    window.location.href = `https://wa.me/${supportPhone}?text=Olá,%20gostaria%20de%20receber%20um%20teste%20IPTV`;
  }
}
```
