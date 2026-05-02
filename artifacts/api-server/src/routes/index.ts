import { Router, type IRouter } from "express";
import healthRouter from "./health";
import playersRouter from "./players";
import agentRouter from "./agent";
import syncRouter from "./sync";
import programsRouter from "./programs";
import messagesRouter from "./messages";
import importRouter from "./import";
import adminRouter from "./admin";
import templatesRouter from "./templates";
import eventsRouter from "./events";
import feedbackRouter from "./feedback";

const router: IRouter = Router();

router.use(healthRouter);
router.use(playersRouter);
router.use(agentRouter);
router.use(syncRouter);
router.use(programsRouter);
router.use(messagesRouter);
router.use(importRouter);
router.use(adminRouter);
router.use(templatesRouter);
router.use(eventsRouter);
router.use(feedbackRouter);

export default router;
