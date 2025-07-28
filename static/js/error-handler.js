function showError(msg) {
    const progressSection = document.getElementById('progressSection');
    const errorAlert = document.getElementById('errorAlert');
    const errorMessage = document.getElementById('errorMessage');

    if (progressSection) progressSection.style.display = 'none';
    if (errorMessage) errorMessage.textContent = msg;
    if (errorAlert) errorAlert.style.display = 'block';
}

// Exposition globale au cas où ce fichier est inclus avec un module bundler
window.showError = showError;
