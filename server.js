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
let roundActive = false;

const EXTRA_LIFE_THRESHOLD = 1000;

function broadcastState() {
  io.emit('state_update', {
    players,
    pendingQueue,
    currentPrompt,
    currentTargetId: players[currentTurnIndex]?.id || null,
    roundActive
  });
}

function advanceTurn() {
  const alivePlayers = players.filter(p => p.lives > 0);
  if (alivePlayers.length <= 1) {
    endGame(alivePlayers[0]);
    return;
  }

  // Find the next living player sequentially in order
  let nextIndex = currentTurnIndex;
  let attempts = 0;
  do {
    nextIndex = (nextIndex + 1) % players.length;
    attempts++;
  } while (players[nextIndex].lives <= 0 && attempts <= players.length);

  // Check if we completed a full circle back to the starting player
  if (nextIndex === startPlayerIndex || attempts > players.length) {
    roundActive = false;
    currentPrompt = "Orbit complete! Waiting for teacher to finish grading...";
  } else {
    currentTurnIndex = nextIndex;
  }

  broadcastState();
}

function endGame(winner) {
  roundActive = false;
  
  currentPrompt = winner 
    ? `🎉 Winner! ${winner.nickname} is the last cell standing!` 
    : `Round over! All cells perished.`;
  
  if (winner) {
    winner.atp += 150; // Victory bonus ATP
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
  socket.on('start_round', ({ prompt }) => {
    if (players.length === 0) return;
    if (pendingQueue.length > 0) {
      socket.emit('error_msg', 'Finish grading pending answers first!');
      return;
    }

    currentPrompt = prompt;
    roundActive = true;
    startPlayerIndex = 0;
    currentTurnIndex = 0;

    players.forEach(p => { if (p.lives > 0) p.status = 'waiting'; });
    broadcastState();
  });

  // 3. Player Submits Answer -> Goes to Pending Queue & Advances Turn Instantly
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
        player.lives = Math.max(0, player.lives - 1);
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

    if (!roundActive && pendingQueue.length === 0) {
      currentPrompt = "All graded! Ready for next prompt.";
    }

    broadcastState();
  });

  // 5. Reset Game / New Round Handler
  socket.on('reset_game', () => {
    players.forEach(p => {
      p.lives = 2;
      p.status = 'waiting';
    });

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