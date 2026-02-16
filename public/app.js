const form = document.getElementById('lead-form');
const emailInput = document.getElementById('email');
const submitBtn = document.getElementById('submit-btn');
const successBlock = document.getElementById('success');
const telegramLink = document.getElementById('telegram-link');
const hint = document.getElementById('form-hint');

const UTM_KEYS = [
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_content',
  'utm_term',
];

const telegramUrl = document.body.dataset.telegramUrl || 'https://t.me/';
const telegramLinks = document.querySelectorAll('.js-telegram-link');
telegramLinks.forEach((link) => {
  link.href = telegramUrl;
  link.setAttribute('target', '_blank');
  link.setAttribute('rel', 'noopener');
});

function getUtmParams() {
  const params = new URLSearchParams(window.location.search);
  const utm = {};
  for (const key of UTM_KEYS) {
    const value = params.get(key);
    if (value) {
      utm[key] = value;
    }
  }
  return utm;
}

const utmParams = getUtmParams();

function setHint(text, isError = false) {
  hint.textContent = text;
  hint.style.color = isError ? '#d98b8b' : '';
}

function setLoading(isLoading) {
  submitBtn.disabled = isLoading;
  submitBtn.textContent = isLoading ? 'Надсилаю…' : 'Отримати інвайт';
}

function showSuccess(url) {
  successBlock.hidden = false;
  telegramLink.href = url || 'https://t.me/';
  telegramLink.setAttribute('target', '_blank');
  telegramLink.setAttribute('rel', 'noopener');
  setHint('Готово. Далі — у Telegram.');

  setTimeout(() => {
    if (url) {
      window.location.href = url;
    }
  }, 1200);
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  const email = emailInput.value.trim();

  if (!email) {
    setHint('Вкажи email або відкрий Telegram.', true);
    return;
  }

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    setHint('Перевір email. Формат має бути на кшталт email@domain.com', true);
    return;
  }

  setLoading(true);

  try {
    const response = await fetch('/api/leads', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, ...utmParams }),
    });

    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.ok) {
      setHint('Не вдалося зберегти email. Спробуй ще раз.', true);
      return;
    }

    showSuccess(data.telegramUrl || telegramUrl);
  } catch (error) {
    setHint('Сталася помилка. Спробуй пізніше.', true);
  } finally {
    setLoading(false);
  }
});
