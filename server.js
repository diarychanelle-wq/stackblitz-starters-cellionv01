const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static('public'));

// Game State (Source of Truth)
let players = []; // { id, nickname, atp, lives, status }
let pendingQueue = []; // { playerId, nickname, answer }
let currentPrompt = null;
let currentTurnIndex = 0;
let startPlayerIndex = 0;
let turnTimer = null;
let timeLeft = 0;
let questionDuration = 15;
let roundActive = false;

const EXTRA_LIFE_THRESHOLD = 1000;

function broadcastState() {
  io.emit('state_update', {
    players,
    pendingQueue,
    currentPrompt,
    currentTargetId: players[currentTurnIndex]?.id || null,
    timeLeft,
    roundActive
  });
}

function advanceTurn() {
  clearInterval(turnTimer);

  // Check if anyone is even left alive first
  const alivePlayers = players.filter(p => p.lives > 0);
  if (alivePlayers.length <= 1) {
    endGame(alivePlayers[0]);
    return;
  }

  // Move to next alive player
  let attempts = 0;
  do {
    currentTurnIndex = (currentTurnIndex + 1) % players.length;
    attempts++;
  } while (players[currentTurnIndex].lives <= 0 && attempts <= players.length);

  // Check if the hot potato made a full orbit back to the starting player
  if (currentTurnIndex === startPlayerIndex || attempts > players.length) {
    roundActive = false;
    currentPrompt = "Orbit complete! Waiting for teacher to finish grading...";
    broadcastState();
    return;
  }

  startTurnTimer();
}

function startTurnTimer() {
  if (!roundActive) return;
  
  // Clear old timer if running
  if (turnTimer) clearInterval(turnTimer);

  turnTimer = setInterval(() => {
    if (!roundActive) return;
    
    // Find next living player using currentTurnIndex (fixed variable match)
    do {
      currentTurnIndex = (currentTurnIndex + 1) % players.length;
    } while (players[currentTurnIndex].lives <= 0);

    broadcastState();
  }, questionDuration * 1000); 
}

function endGame(winner) {
  clearInterval(turnTimer);
  roundActive = false;
  
  currentPrompt = winner 
    ? `🎉 Winner! ${winner.nickname} is the last cell standing!` 
    : `Round over! All cells perished.`;
  
  if (winner) {
    winner.atp += 150; // Victory bonus ATP!
  }
  
  broadcastState();
}

io.on('connection', (socket) => {
  // 1. Join Game (Capped at 10 Players)
  socket.on('join_game', (nickname) => {
    if (players.length >= 10) {
      socket.emit('error_msg', 'Petri dish is full (10/10 players)!');
      return;
    }
    players.push({
      id: socket.id,
      nickname: nickname || `Cell_${players.length + 1}`,
      atp: 0,
      lives: 2,
      status: 'waiting'
    });
    broadcastState();
  });

  // 2. Teacher Starts New Prompt Round
  socket.on('start_round', ({ prompt, duration }) => {
    if (players.length === 0) return;
    if (pendingQueue.length > 0) {
      socket.emit('error_msg', 'Finish grading pending answers first!');
      return;
    }

    currentPrompt = prompt;
    questionDuration = parseInt(duration) || 15;
    roundActive = true;
    startPlayerIndex = 0;
    currentTurnIndex = 0;

    players.forEach(p => { if (p.lives > 0) p.status = 'waiting'; });
    startTurnTimer();
    broadcastState();
  });

  // 3. Player Submits Answer -> Goes to Pending Queue
  socket.on('submit_answer', (answerText) => {
    if (!roundActive) return;
    const activePlayer = players[currentTurnIndex];
    if (!activePlayer || activePlayer.id !== socket.id) return;

    activePlayer.status = 'pending';
    pendingQueue.push({
      playerId: activePlayer.id,
      nickname: activePlayer.nickname,
      answer: answerText
    });

    advanceTurn();
  });

  // 4. Teacher Grades Pending Answer
  socket.on('grade_answer', ({ playerId, gradeType }) => {
    const queueIdx = pendingQueue.findIndex(item => item.playerId === playerId);
    if (queueIdx === -1) return;

    const player = players.find(p => p.id === playerId);
    pendingQueue.splice(queueIdx, 1);

    if (player) {
      if (gradeType === 'WRONG') {
        player.lives = Math.max(0, player.lives - 1); // Fixed missing operator
        player.status = 'wrong';
      } else {
        const atpAward = parseInt(gradeType) || 25; 
        const prevThreshold = Math.floor(player.atp / EXTRA_LIFE_THRESHOLD);
        player.atp += atpAward;
        const newThreshold = Math.floor(player.atp / EXTRA_LIFE_THRESHOLD);

        if (newThreshold > prevThreshold) {
          player.lives++; // Extra life earned!
        }
        player.status = `graded (+${atpAward} ATP)`;
      }
    }

    const alivePlayers = players.filter(p => p.lives > 0);
    if (alivePlayers.length <= 1) {
      endGame(alivePlayers[0]);
      return;
    }

    // If orbit is done AND teacher just graded the final card, clear prompt for next round
    if (!roundActive && pendingQueue.length === 0) {
      currentPrompt = "All graded! Ready for next prompt.";
    }

    broadcastState();
  });

  // 5. Reset Game / New Round Handler
  socket.on('reset_game', () => {
    if (turnTimer) clearInterval(turnTimer);

    // Reset player lives & stats
    players.forEach(p => {
      p.lives = 2;
      p.status = 'waiting';
    });

    // Clear queues & game states
    pendingQueue = [];
    roundActive = false;
    currentTurnIndex = 0;
    startPlayerIndex = 0;
    currentPrompt = "Game reset! Teacher can send the first prompt.";

    broadcastState();
  });

  // Handle Disconnect
  socket.on('disconnect', () => {
    players = players.filter(p => p.id !== socket.id);
    const alivePlayers = players.filter(p => p.lives > 0);
    if (roundActive && alivePlayers.length <= 1) {
      endGame(alivePlayers[0]);
    } else {
      broadcastState();
    }
  });
});

const PORT = process.env.PORT || 3004;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`Cellion server running on port ${PORT}`);
});

