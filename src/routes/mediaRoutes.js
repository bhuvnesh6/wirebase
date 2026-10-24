import { Router } from 'express';
import { resolveMediaFile } from '../services/mediaService.js';

const router = Router();

// Public (no session) - protected by the signed ?token=... in the URL.
router.get('/:instanceId/:fileName', (req, res) => {
  const filePath = resolveMediaFile(req.params.instanceId, req.params.fileName, req.query.token);
  if (!filePath) return res.status(404).json({ error: 'Not found' });

  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Security-Policy', "sandbox; default-src 'none'");
  res.setHeader('Cache-Control', 'private, max-age=3600');
  res.sendFile(filePath);
});

export default router;