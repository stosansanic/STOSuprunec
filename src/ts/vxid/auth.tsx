//src\ts\vxid\auth.tsx
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "../../scss/main.scss";
import App from "./App.tsx";
import { signInWithGoogle } from "./login.ts";

// Флаг щоб запобігти подвійному кліку
let isLoggingIn = false;

// Чекаємо поки DOM завантажиться
document.addEventListener("DOMContentLoaded", () => {
  // перевірка localStorage
  const user = localStorage.getItem("user");

  if (user) {
    createRoot(document.getElementById("root")!).render(
      <StrictMode>
        <App />
      </StrictMode>
    );
  } else {
    // Прив'язка кнопки входу з HTML (id="login")
    const loginButton = document.getElementById("login");
    if (loginButton) {
      loginButton.addEventListener("click", async (e) => {
        e.preventDefault();
        
        // Запобігаємо подвійному кліку
        if (isLoggingIn) {
          return;
        }
        
        isLoggingIn = true;
        loginButton.setAttribute("disabled", "true");
        
        try {
          await signInWithGoogle();
        } finally {
          // Відновлюємо кнопку через 3 сек якщо OAuth не відкрився
          setTimeout(() => {
            isLoggingIn = false;
            loginButton.removeAttribute("disabled");
          }, 3000);
        }
      });
    } else {
      // console.warn("⚠️ Кнопка login не знайдена в DOM");
    }
  }
});
