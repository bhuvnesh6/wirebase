import { Router } from 'express';
import { requireAuth } from '../middleware/session.js';
import * as ctrl from '../controllers/instanceController.js';

const router = Router();
router.use(requireAuth);

router.get('/', ctrl.listInstances);
router.post('/', ctrl.createInstance);
router.get('/proxy-pool', ctrl.listProxyPool);

router.get('/:id', ctrl.getInstance);
router.post('/:id/connect', ctrl.connectInstance);
router.post('/:id/disconnect', ctrl.disconnectInstance);
router.delete('/:id', ctrl.deleteInstance);

router.patch('/:id/webhook', ctrl.updateWebhook);
router.patch('/:id/proxy', ctrl.updateProxy);

router.get('/:id/groups', ctrl.listGroups);
router.patch('/:id/groups', ctrl.updateSelectedGroups);

router.get('/:id/messages', ctrl.getMessages);
router.post('/:id/send', ctrl.sendTestMessage);

export default router;