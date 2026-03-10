// Reinforcement Learning (Q-Learning) Engine for ATC Simulator
// Maps (difficulty, weakest_category) -> scenario_type with reward = score/100

export type ScenarioType = 'Normal Traffic' | 'Heavy Traffic' | 'Emergency';

const RL_ALPHA = 0.3;   // Learning rate
const RL_GAMMA = 0.7;   // Discount factor
const RL_EPSILON = 0.2; // Exploration rate

interface RLState {
  weakestCategory: string; // 'altitude', 'callsign', etc. or 'None'
}

type QTable = Record<string, Record<string, number>>;

// Initialize or load Q-Table from localStorage
export function loadQTable(): QTable {
  const stored = localStorage.getItem('skycoach_qtable');
  if (stored) {
    try {
      return JSON.parse(stored);
    } catch {
      return {};
    }
  }
  return {};
}

function saveQTable(table: QTable) {
  localStorage.setItem('skycoach_qtable', JSON.stringify(table));
}

// State stringifier
function getStateKey(state: RLState): string {
  return state.weakestCategory || 'None';
}

// Update Q-value based on reward (score)
export function updateQValue(
  state: RLState,
  action: ScenarioType,
  reward: number, // 0.0 to 1.0 (score / 100)
  nextState: RLState
) {
  const table = loadQTable();
  const stateKey = getStateKey(state);
  const nextStateKey = getStateKey(nextState);

  // Initialize if missing
  if (!table[stateKey]) table[stateKey] = { 'Normal Traffic': 0, 'Heavy Traffic': 0, 'Emergency': 0 };
  if (!table[nextStateKey]) table[nextStateKey] = { 'Normal Traffic': 0, 'Heavy Traffic': 0, 'Emergency': 0 };

  const currentQ = table[stateKey][action] || 0;
  
  // Find max Q for next state
  const maxNextQ = Math.max(...Object.values(table[nextStateKey]));

  // Bellman Equation
  // Q(s,a) = Q(s,a) + alpha * [reward + gamma * max_a' Q(s',a') - Q(s,a)]
  const newQ = currentQ + RL_ALPHA * (reward + RL_GAMMA * maxNextQ - currentQ);
  
  table[stateKey][action] = newQ;
  saveQTable(table);
}

// Choose next scenario using Epsilon-Greedy policy
export function selectRLScenario(state: RLState): ScenarioType {
  const table = loadQTable();
  const stateKey = getStateKey(state);

  // Initialize
  if (!table[stateKey]) table[stateKey] = { 'Normal Traffic': 0, 'Heavy Traffic': 0, 'Emergency': 0 };

  // Explore
  if (Math.random() < RL_EPSILON) {
    const actions: ScenarioType[] = ['Normal Traffic', 'Heavy Traffic', 'Emergency'];
    return actions[Math.floor(Math.random() * actions.length)];
  }

  // Exploit
  const qValues = table[stateKey];
  let bestAction: ScenarioType = 'Normal Traffic';
  let bestValue = -Infinity;

  for (const [action, value] of Object.entries(qValues)) {
    if (value > bestValue) {
      bestValue = value;
      bestAction = action as ScenarioType;
    }
  }

  return bestAction;
}

// Generates human-readable recommendation based on state
export function getRLRecommendations(state: RLState): string[] {
  if (state.weakestCategory === 'None') {
    return ["You're doing great across the board. Keep practicing with Normal Traffic to maintain your skills."];
  }

  const table = loadQTable();
  const stateKey = getStateKey(state);
  const qValues = table[stateKey] || {};

  let bestAction = 'Normal Traffic';
  let bestVal = -Infinity;
  for (const [a, v] of Object.entries(qValues)) {
    if (v > bestVal) { bestVal = v; bestAction = a; }
  }

  return [
    `Your weakest area recently is **${state.weakestCategory.toUpperCase()}**.`,
    `The RL engine recommends practicing **${bestAction}** scenarios, as historically this yields the best learning progress for this weakness.`
  ];
}
