import type { FastifyInstance, FastifyRequest } from "fastify";
import { assessFishingTrip } from "../domain/assessment.js";
import { FishingAssessmentInputSchema, FisherContextSchema } from "../types/fishing.js";

type AssessmentBody = {
  fisherContext?: unknown;
  input?: unknown;
};

export async function registerAssessmentRoutes(app: FastifyInstance): Promise<void> {
  app.post(
    "/v1/assess",
    async (request: FastifyRequest<{ Body: AssessmentBody }>, reply) => {
      try {
        const body = request.body ?? {};
        const context = FisherContextSchema.parse(body.fisherContext);
        const input = FishingAssessmentInputSchema.parse(body.input ?? {});
        const assessment = await assessFishingTrip(context, input);
        return reply.send(assessment);
      } catch (error) {
        return reply.code(400).send({
          error: error instanceof Error ? error.message : "Assessment request is invalid.",
        });
      }
    },
  );
}
