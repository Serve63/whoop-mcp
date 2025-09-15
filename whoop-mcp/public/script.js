const statusCard = document.querySelector(".status-card");
const statusValue = document.getElementById("status-value");
const yearEl = document.getElementById("year");

if (yearEl) {
  yearEl.textContent = new Date().getFullYear();
}

async function updateStatus() {
  if (!statusCard || !statusValue) return;
  statusValue.textContent = "Controleren…";
  statusCard.classList.remove("online");

  try {
    const response = await fetch("/health", { cache: "no-store" });
    if (response.ok) {
      const payload = await response.json().catch(() => ({}));
      statusValue.textContent = payload?.ok ? "Online" : "Onbekende status";
      if (payload?.ok) {
        statusCard.classList.add("online");
      }
    } else {
      statusValue.textContent = `Offline (${response.status})`;
    }
  } catch (error) {
    statusValue.textContent = "Niet bereikbaar";
    console.error("Health check mislukt", error);
  }
}

updateStatus();
setInterval(updateStatus, 60000);

const copyButtons = document.querySelectorAll("[data-copy-target]");
copyButtons.forEach((button) => {
  button.addEventListener("click", () => {
    const target = document.querySelector(button.dataset.copyTarget);
    if (!target) return;
    const text = target.innerText.trim();
    navigator.clipboard.writeText(text).then(() => {
      const original = button.textContent;
      button.textContent = "Gekopieerd!";
      button.disabled = true;
      setTimeout(() => {
        button.textContent = original;
        button.disabled = false;
      }, 2000);
    }).catch(() => {
      button.textContent = "Mislukt";
      setTimeout(() => {
        button.textContent = "Kopieer";
      }, 2000);
    });
  });
});
