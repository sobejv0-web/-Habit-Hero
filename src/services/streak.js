const dayjs = require('dayjs');

function buildStatusMap(checkins) {
  const map = new Map();
  for (const checkin of checkins) {
    map.set(checkin.date, checkin.status);
  }
  return map;
}

function calculateCurrentStreak(checkins, today = dayjs()) {
  const statusMap = buildStatusMap(checkins);
  let streak = 0;
  let cursor = today.startOf('day');

  while (true) {
    const dateKey = cursor.format('YYYY-MM-DD');
    if (statusMap.get(dateKey) === 'done') {
      streak += 1;
      cursor = cursor.subtract(1, 'day');
    } else {
      break;
    }
  }

  return streak;
}

function calculateSevenDayCompletion(checkins, today = dayjs()) {
  const statusMap = buildStatusMap(checkins);
  let doneCount = 0;

  for (let i = 0; i < 7; i += 1) {
    const dateKey = today.subtract(i, 'day').format('YYYY-MM-DD');
    if (statusMap.get(dateKey) === 'done') {
      doneCount += 1;
    }
  }

  return Math.round((doneCount / 7) * 100);
}

module.exports = {
  calculateCurrentStreak,
  calculateSevenDayCompletion,
};
