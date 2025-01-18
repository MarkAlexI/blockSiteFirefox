export function customAlert(message) {
  const alertDiv = document.createElement("div");
  alertDiv.textContent = message;
  alertDiv.style.position = "fixed";
  alertDiv.style.top = "50%";
  alertDiv.style.left = "50%";
  alertDiv.style.transform = "translate(-50%, -50%)";
  alertDiv.style.backgroundColor = "rgba(0, 0, 0, 0.8)";
  alertDiv.style.color = "#fff";
  alertDiv.style.padding = "20px 40px";
  alertDiv.style.borderRadius = "8px";
  alertDiv.style.boxShadow = "0 4px 10px rgba(0, 0, 0, 0.3)";
  alertDiv.style.fontSize = "16px";
  alertDiv.style.zIndex = "1000";
  alertDiv.style.textAlign = "center";
  alertDiv.style.opacity = "1";
  alertDiv.style.transition = "opacity 0.5s ease-out";

  document.body.appendChild(alertDiv);

  setTimeout(() => {
    alertDiv.style.opacity = "0";
    setTimeout(() => {
      alertDiv.remove();
    }, 500);
  }, 3000);
}