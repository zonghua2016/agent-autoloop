const form = document.getElementById("login");
form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const input = document.getElementById("owner-key");
  const button = form.querySelector("button");
  const status = document.getElementById("login-status");
  button.disabled = true;
  status.textContent = "正在登录…";
  const key = input.value;
  input.value = "";
  try {
    const response = await fetch("/api/login", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key }),
      signal: AbortSignal.timeout(10000),
    });
    const result = await response.json();
    if (!response.ok) throw Error(result.error || "暂时无法登录，请稍后重试");
    location.replace("/");
  } catch (error) {
    status.textContent = error.name === "TimeoutError" ? "连接超时，请重试" : error.message;
    button.disabled = false;
    input.focus();
  }
});

form.querySelector("button").disabled = false;
