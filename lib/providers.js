function getProfile(config, profileId) {
  const match = config.profiles.find((profile) => profile.id === profileId);
  if (!match) {
    throw new Error(`Unknown profile: ${profileId}`);
  }
  return match;
}

function getSystemPrompt(messages) {
  return messages
    .filter((message) => message.role === "system")
    .map((message) => message.content)
    .join("\n\n")
    .trim();
}

function getConversationMessages(messages) {
  return messages
    .filter((message) => message.role !== "system")
    .map((message) => ({
      role: message.role,
      content: message.content
    }));
}

function asText(value) {
  if (typeof value === "string") {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map(asText).join("\n");
  }

  if (value && typeof value === "object") {
    if (typeof value.text === "string") {
      return value.text;
    }
    if (typeof value.content === "string") {
      return value.content;
    }
  }

  return value == null ? "" : JSON.stringify(value, null, 2);
}

function interpolateString(template, replacements) {
  return Object.entries(replacements).reduce((result, [token, value]) => {
    return result.split(token).join(value);
  }, template);
}

function applyTemplateObject(value, replacements) {
  if (typeof value === "string") {
    return interpolateString(value, replacements);
  }

  if (Array.isArray(value)) {
    return value.map((item) => applyTemplateObject(item, replacements));
  }

  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, applyTemplateObject(entry, replacements)])
    );
  }

  return value;
}

function extractByPath(source, responsePath) {
  if (!responsePath) {
    return "";
  }

  return responsePath.split(".").reduce((current, segment) => {
    if (current == null) {
      return undefined;
    }

    const index = Number(segment);
    if (Number.isInteger(index) && String(index) === segment) {
      return current[index];
    }

    return current[segment];
  }, source);
}

async function readJsonResponse(response) {
  const text = await response.text();

  if (!response.ok) {
    throw new Error(`Provider request failed (${response.status}): ${text}`);
  }

  return JSON.parse(text);
}

async function sendOpenAICompatible(profile, messages) {
  const response = await fetch(new URL(profile.path || "/v1/chat/completions", profile.baseUrl), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${profile.apiKey}`
    },
    body: JSON.stringify({
      model: profile.model,
      temperature: 0.2,
      messages: messages.map((message) => ({
        role: message.role,
        content: message.content
      }))
    })
  });

  const data = await readJsonResponse(response);
  return asText(data.choices?.[0]?.message?.content);
}

async function streamOpenAICompatible(profile, messages, onToken) {
  const response = await fetch(new URL(profile.path || "/v1/chat/completions", profile.baseUrl), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${profile.apiKey}`
    },
    body: JSON.stringify({
      model: profile.model,
      temperature: 0.2,
      stream: true,
      messages: messages.map((message) => ({
        role: message.role,
        content: message.content
      }))
    })
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Provider request failed (${response.status}): ${text}`);
  }

  if (!response.body) {
    throw new Error("Streaming response body is not available.");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let eventLines = [];
  let fullText = "";

  async function flushEvent() {
    if (eventLines.length === 0) {
      return false;
    }

    const dataPayload = eventLines
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n");

    eventLines = [];

    if (!dataPayload) {
      return false;
    }

    if (dataPayload === "[DONE]") {
      return true;
    }

    const parsed = JSON.parse(dataPayload);
    const choice = parsed.choices?.[0];
    const delta = choice?.delta || {};
    const piece = asText(delta.content ?? delta.reasoning_content ?? delta.text ?? "");

    if (piece) {
      fullText += piece;
      if (onToken) {
        await onToken(piece, parsed);
      }
    }

    return false;
  }

  while (true) {
    const { value, done } = await reader.read();
    buffer += decoder.decode(value || new Uint8Array(), { stream: !done });

    let newlineIndex = buffer.indexOf("\n");
    while (newlineIndex !== -1) {
      let line = buffer.slice(0, newlineIndex);
      buffer = buffer.slice(newlineIndex + 1);

      if (line.endsWith("\r")) {
        line = line.slice(0, -1);
      }

      if (line === "") {
        const shouldStop = await flushEvent();
        if (shouldStop) {
          return fullText;
        }
      } else {
        eventLines.push(line);
      }

      newlineIndex = buffer.indexOf("\n");
    }

    if (done) {
      if (buffer) {
        eventLines.push(buffer);
        buffer = "";
      }
      await flushEvent();
      return fullText;
    }
  }
}

async function sendAnthropic(profile, messages) {
  const system = getSystemPrompt(messages);
  const response = await fetch(new URL(profile.path || "/v1/messages", profile.baseUrl), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "anthropic-version": "2023-06-01",
      "x-api-key": profile.apiKey
    },
    body: JSON.stringify({
      model: profile.model,
      max_tokens: 2048,
      system,
      messages: getConversationMessages(messages)
    })
  });

  const data = await readJsonResponse(response);
  return asText(data.content);
}

async function sendGemini(profile, messages) {
  const endpointTemplate = (profile.path || "/v1beta/models/{model}:generateContent").replace("{model}", profile.model);
  const endpoint = new URL(endpointTemplate, profile.baseUrl);
  endpoint.searchParams.set("key", profile.apiKey);

  const system = getSystemPrompt(messages);
  const contents = getConversationMessages(messages).map((message) => ({
    role: message.role === "assistant" ? "model" : "user",
    parts: [{ text: message.content }]
  }));

  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      systemInstruction: system ? { parts: [{ text: system }] } : undefined,
      contents
    })
  });

  const data = await readJsonResponse(response);
  return asText(data.candidates?.[0]?.content?.parts?.map((part) => part.text).join("\n"));
}

async function sendGenericJson(profile, messages) {
  const system = getSystemPrompt(messages);
  const conversation = getConversationMessages(messages);
  const lastUser = [...conversation].reverse().find((message) => message.role === "user")?.content || "";
  const endpoint = new URL(profile.path || "/", profile.baseUrl);
  const headerTemplate = profile.headersTemplate?.trim() ? profile.headersTemplate : "{}";
  const bodyTemplate = profile.bodyTemplate?.trim()
    ? profile.bodyTemplate
    : "{\n  \"model\": {{model_json}},\n  \"messages\": {{messages_json}}\n}";

  const replacements = {
    "{{api_key}}": profile.apiKey || "",
    "{{model}}": profile.model || "",
    "{{model_json}}": JSON.stringify(profile.model || ""),
    "{{system_prompt}}": system,
    "{{system_prompt_json}}": JSON.stringify(system),
    "{{last_user_message}}": lastUser,
    "{{last_user_message_json}}": JSON.stringify(lastUser),
    "{{messages_json}}": JSON.stringify(conversation)
  };

  const headers = applyTemplateObject(JSON.parse(headerTemplate), replacements);
  const body = JSON.parse(interpolateString(bodyTemplate, replacements));
  const response = await fetch(endpoint, {
    method: profile.method || "POST",
    headers,
    body: JSON.stringify(body)
  });

  const data = await readJsonResponse(response);
  return asText(extractByPath(data, profile.responsePath || "choices.0.message.content"));
}

async function sendChat(config, profileId, messages) {
  const profile = getProfile(config, profileId);

  if (!profile.apiKey && profile.type !== "generic-json") {
    throw new Error(`Profile "${profile.name}" has no API key.`);
  }

  switch (profile.type) {
    case "openai-compatible":
      return sendOpenAICompatible(profile, messages);
    case "anthropic":
      return sendAnthropic(profile, messages);
    case "gemini":
      return sendGemini(profile, messages);
    case "generic-json":
      return sendGenericJson(profile, messages);
    default:
      throw new Error(`Unsupported profile type: ${profile.type}`);
  }
}

async function sendChatStream(config, profileId, messages, handlers = {}) {
  const profile = getProfile(config, profileId);

  if (!profile.apiKey && profile.type !== "generic-json") {
    throw new Error(`Profile "${profile.name}" has no API key.`);
  }

  switch (profile.type) {
    case "openai-compatible":
      return streamOpenAICompatible(profile, messages, handlers.onToken);
    default: {
      const content = await sendChat(config, profileId, messages);
      if (handlers.onToken) {
        await handlers.onToken(content);
      }
      return content;
    }
  }
}

module.exports = {
  sendChat,
  sendChatStream
};
