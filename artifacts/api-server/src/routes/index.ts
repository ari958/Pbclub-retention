import { Router, type IRouter } from "express";
import healthRouter from "./health";
import playersRouter from "./players";
import agentRouter from "./agent";
import syncRouter from "./sync";
import programsRouter from "./programs";

const router: IRouter = Router();

router.use(healthRouter);
router.use(playersRouter);
router.use(agentRouter);
router.use(syncRouter);
router.use(programsRouter);

export default router;
