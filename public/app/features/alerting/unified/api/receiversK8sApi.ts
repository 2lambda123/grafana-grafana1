import { generatedReceiversApi } from 'app/features/alerting/unified/openapi/receiversApi.gen';

export const receiversApi = generatedReceiversApi.enhanceEndpoints({
  endpoints: {
    createNamespacedReceiver: {
      invalidatesTags: ['Receiver', 'ContactPoint', 'ContactPointsStatus', 'AlertmanagerConfiguration'],
    },
  },
});
