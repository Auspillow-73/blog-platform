const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const cors = require('cors');
const path = require('path');
const db = require('./database');
const { authenticate, SECRET } = require('./auth');

const app = express();
const PORT = 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ========== AUTH ==========

// Register
app.post('/api/auth/register', async (req, res) => {
  const { username, email, password } = req.body;
  if (!username || !email || !password) {
    return res.status(400).json({ error: 'All fields required' });
  }

  const hashed = await bcrypt.hash(password, 10);
  db.run(
    'INSERT INTO users (username, email, password) VALUES (?, ?, ?)',
    [username, email, hashed],
    function(err) {
      if (err) {
        if (err.message.includes('UNIQUE')) {
          return res.status(409).json({ error: 'Username or email already exists' });
        }
        return res.status(500).json({ error: err.message });
      }
      const token = jwt.sign({ id: this.lastID, username }, SECRET, { expiresIn: '24h' });
      res.status(201).json({ message: 'User created', token, user: { id: this.lastID, username, email } });
    }
  );
});

// Login
app.post('/api/auth/login', (req, res) => {
  const { username, password } = req.body;
  db.get('SELECT * FROM users WHERE username = ?', [username], async (err, user) => {
    if (err || !user) return res.status(401).json({ error: 'Invalid credentials' });
    
    const valid = await bcrypt.compare(password, user.password);
    if (!valid) return res.status(401).json({ error: 'Invalid credentials' });
    
    const token = jwt.sign({ id: user.id, username: user.username }, SECRET, { expiresIn: '24h' });
    res.json({ message: 'Login successful', token, user: { id: user.id, username: user.username, email: user.email } });
  });
});

// Get current user
app.get('/api/auth/me', authenticate, (req, res) => {
  db.get('SELECT id, username, email, created_at FROM users WHERE id = ?', [req.user.id], (err, user) => {
    if (err || !user) return res.status(404).json({ error: 'User not found' });
    res.json(user);
  });
});

// ========== POSTS ==========

// Get all posts
app.get('/api/posts', (req, res) => {
  db.all(
    `SELECT p.*, u.username as author_name 
     FROM posts p 
     JOIN users u ON p.author_id = u.id 
     ORDER BY p.created_at DESC`,
    [],
    (err, rows) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json(rows);
    }
  );
});

// Get single post
app.get('/api/posts/:id', (req, res) => {
  const postId = req.params.id;
  db.get(
    `SELECT p.*, u.username as author_name 
     FROM posts p 
     JOIN users u ON p.author_id = u.id 
     WHERE p.id = ?`,
    [postId],
    (err, post) => {
      if (err || !post) return res.status(404).json({ error: 'Post not found' });
      
      db.all(
        `SELECT c.*, u.username as author_name 
         FROM comments c 
         JOIN users u ON c.author_id = u.id 
         WHERE c.post_id = ? 
         ORDER BY c.created_at ASC`,
        [postId],
        (err, comments) => {
          if (err) return res.status(500).json({ error: err.message });
          res.json({ ...post, comments });
        }
      );
    }
  );
});

// Create post
app.post('/api/posts', authenticate, (req, res) => {
  const { title, content } = req.body;
  if (!title || !content) return res.status(400).json({ error: 'Title and content required' });

  db.run(
    'INSERT INTO posts (title, content, author_id, author_name) VALUES (?, ?, ?, ?)',
    [title, content, req.user.id, req.user.username],
    function(err) {
      if (err) return res.status(500).json({ error: err.message });
      res.status(201).json({ id: this.lastID, title, content, author_id: req.user.id, author_name: req.user.username });
    }
  );
});

// Update post
app.put('/api/posts/:id', authenticate, (req, res) => {
  const { title, content } = req.body;
  const postId = req.params.id;

  db.get('SELECT * FROM posts WHERE id = ?', [postId], (err, post) => {
    if (err || !post) return res.status(404).json({ error: 'Post not found' });
    if (post.author_id !== req.user.id) return res.status(403).json({ error: 'Not authorized' });

    db.run(
      'UPDATE posts SET title = ?, content = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
      [title, content, postId],
      function(err) {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ message: 'Post updated', id: postId });
      }
    );
  });
});

// Delete post
app.delete('/api/posts/:id', authenticate, (req, res) => {
  const postId = req.params.id;

  db.get('SELECT * FROM posts WHERE id = ?', [postId], (err, post) => {
    if (err || !post) return res.status(404).json({ error: 'Post not found' });
    if (post.author_id !== req.user.id) return res.status(403).json({ error: 'Not authorized' });

    db.run('DELETE FROM posts WHERE id = ?', [postId], function(err) {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ message: 'Post deleted' });
    });
  });
});

// ========== COMMENTS ==========

// Add comment
app.post('/api/posts/:id/comments', authenticate, (req, res) => {
  const postId = req.params.id;
  const { content } = req.body;
  if (!content) return res.status(400).json({ error: 'Comment content required' });

  db.get('SELECT id FROM posts WHERE id = ?', [postId], (err, post) => {
    if (err || !post) return res.status(404).json({ error: 'Post not found' });

    db.run(
      'INSERT INTO comments (post_id, author_id, author_name, content) VALUES (?, ?, ?, ?)',
      [postId, req.user.id, req.user.username, content],
      function(err) {
        if (err) return res.status(500).json({ error: err.message });
        res.status(201).json({ 
          id: this.lastID, 
          post_id: postId, 
          author_id: req.user.id, 
          author_name: req.user.username, 
          content,
          created_at: new Date().toISOString()
        });
      }
    );
  });
});

// Delete comment
app.delete('/api/comments/:id', authenticate, (req, res) => {
  const commentId = req.params.id;
  
  db.get('SELECT * FROM comments WHERE id = ?', [commentId], (err, comment) => {
    if (err || !comment) return res.status(404).json({ error: 'Comment not found' });
    if (comment.author_id !== req.user.id) return res.status(403).json({ error: 'Not authorized' });

    db.run('DELETE FROM comments WHERE id = ?', [commentId], function(err) {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ message: 'Comment deleted' });
    });
  });
});

app.listen(PORT, () => {
  console.log(`🚀 Server running at http://localhost:${PORT}`);
});