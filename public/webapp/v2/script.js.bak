// --- CONFIG & STATE ---
const TG = window.Telegram.WebApp;
TG.expand();

let state = JSON.parse(localStorage.getItem('habitHeroState')) || {
    level: 1,
    xp: 0,
    coins: 0,
    habits: []
};

// --- DOM ELEMENTS ---
const els = {
    xpFill: document.querySelector('.xp-bar-fill'),
    xpText: document.querySelector('.xp-footer span'),
    lvlBadge: document.querySelector('.level-badge'),
    coinBal: document.getElementById('coin-balance'),
    rankName: document.getElementById('user-rank-name'),
    habitsList: document.getElementById('habits-list'),
    modal: document.getElementById('modal-overlay'),
    dailyText: document.getElementById('daily-progress-text')
};

// --- INITIALIZATION ---
function init() {
    updateUI();
    renderHabits();
    console.log("🟦 Deep Blue V2 Logic Loaded");
}

// --- CORE LOGIC ---
function saveState() {
    localStorage.setItem('habitHeroState', JSON.stringify(state));
    updateUI();
}

function updateUI() {
    // XP Bar
    const pct = Math.min((state.xp / 100) * 100, 100);
    els.xpFill.style.width = `${pct}%`;
    els.xpText.innerText = `${state.xp} / 100 XP`;
    els.lvlBadge.innerText = `Уровень ${state.level}`;
    els.coinBal.innerText = state.coins;
    
    // Daily Stats
    const total = state.habits.length;
    const done = state.habits.filter(h => h.completed).length;
    els.dailyText.innerText = `Сегодня выполнено ${done} из ${total}`;
}

function renderHabits() {
    els.habitsList.innerHTML = '';
    
    if (state.habits.length === 0) {
        els.habitsList.innerHTML = `
            <div class="empty-state-card">
                <div class="rocket-icon">🚀</div>
                <h3>Список пуст</h3>
                <p>Самое время начать!</p>
            </div>`;
        return;
    }

    state.habits.forEach((habit, index) => {
        const div = document.createElement('div');
        div.className = `bento-card habit-item ${habit.completed ? 'completed' : ''}`;
        div.onclick = () => toggleHabit(index);
        div.innerHTML = `
            <div style="display:flex; align-items:center; justify-content:space-between;">
                <div style="display:flex; align-items:center; gap:15px;">
                    <div class="habit-icon">${habit.icon || '🔹'}</div>
                    <div class="habit-info">
                        <h4 style="margin:0; font-size:16px;">${habit.name}</h4>
                        <span style="font-size:10px; color:#94a3b8;">${habit.streak} дней подряд</span>
                    </div>
                </div>
                <div class="checkbox ${habit.completed ? 'checked' : ''}">
                    ${habit.completed ? '<i class="fas fa-check"></i>' : ''}
                </div>
            </div>
        `;
        els.habitsList.appendChild(div);
    });
}

function createHabit() {
    const input = document.getElementById('habit-name-input');
    const name = input.value.trim();
    if (!name) return;

    state.habits.push({
        name: name,
        completed: false,
        streak: 0,
        icon: '🔥'
    });
    
    input.value = '';
    closeModal();
    saveState();
    renderHabits();
    TG.HapticFeedback.notificationOccurred('success');
}

function toggleHabit(index) {
    const habit = state.habits[index];
    habit.completed = !habit.completed;
    
    if (habit.completed) {
        gainXP(10);
        TG.HapticFeedback.impactOccurred('medium');
    }
    
    saveState();
    renderHabits();
}

function gainXP(amount) {
    state.xp += amount;
    state.coins += 5;
    if (state.xp >= 100) {
        state.level++;
        state.xp = 0;
        TG.ShowPopup({ title: 'Level Up!', message: `Ты достиг уровня ${state.level}!` });
    }
}

// --- MODAL HANDLERS ---
window.openCreateModal = () => {
    els.modal.classList.remove('hidden');
    els.modal.style.display = 'flex'; // Ensure flex is set
};

window.closeModal = () => {
    els.modal.classList.add('hidden');
    setTimeout(() => els.modal.style.display = 'none', 300);
};

window.saveHabit = createHabit;

window.switchTab = (tab) => {
    document.querySelectorAll('.nav-item').forEach(el => el.classList.remove('active'));
    event.currentTarget.classList.add('active');
    // Logic to hide/show sections can be added here
};

// Start
init();
