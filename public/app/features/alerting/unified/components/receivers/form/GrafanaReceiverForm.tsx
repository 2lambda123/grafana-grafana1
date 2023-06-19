import React, { useEffect, useMemo, useState } from 'react';

import { LoadingPlaceholder } from '@grafana/ui';
import {
  AlertManagerCortexConfig,
  GrafanaManagedReceiverConfig,
  Receiver,
  TestReceiversAlert,
} from 'app/plugins/datasource/alertmanager/types';
import { NotifierDTO, NotifierType, useDispatch } from 'app/types';

import { onCallApi } from '../../../api/onCallApi';
import { useUnifiedAlertingSelector } from '../../../hooks/useUnifiedAlertingSelector';
import {
  fetchGrafanaNotifiersAction,
  testReceiversAction,
  updateAlertManagerConfigAction,
} from '../../../state/actions';
import { GrafanaChannelValues, ReceiverFormValues } from '../../../types/receiver-form';
import { GRAFANA_RULES_SOURCE_NAME, isVanillaPrometheusAlertManagerDataSource } from '../../../utils/datasource';
import { option } from '../../../utils/notifier-types';
import {
  formChannelValuesToGrafanaChannelConfig,
  formValuesToGrafanaReceiver,
  grafanaReceiverToFormValues,
  updateConfigWithReceiver,
} from '../../../utils/receiver-form';
import { ProvisionedResource, ProvisioningAlert } from '../../Provisioning';

import { GrafanaCommonChannelSettings } from './GrafanaCommonChannelSettings';
import { ReceiverForm } from './ReceiverForm';
import { TestContactPointModal } from './TestContactPointModal';

interface Props {
  alertManagerSourceName: string;
  config: AlertManagerCortexConfig;
  existing?: Receiver;
  prefill?: Receiver;
}

const defaultChannelValues: GrafanaChannelValues = Object.freeze({
  __id: '',
  secureSettings: {},
  settings: {},
  secureFields: {},
  disableResolveMessage: false,
  type: 'email',
});

export const GrafanaReceiverForm = ({ existing, prefill, alertManagerSourceName, config }: Props) => {
  const { useCreateIntegrationMutation, useGetOnCallIntegrationsQuery } = onCallApi;

  const [createIntegrationMutation] = useCreateIntegrationMutation();
  const { data: onCallIntegrations = [] } = useGetOnCallIntegrationsQuery();

  const grafanaNotifiers = useUnifiedAlertingSelector((state) => state.grafanaNotifiers);
  const [testChannelValues, setTestChannelValues] = useState<GrafanaChannelValues>();

  const dispatch = useDispatch();

  useEffect(() => {
    if (!(grafanaNotifiers.result || grafanaNotifiers.loading)) {
      dispatch(fetchGrafanaNotifiersAction());
    }
  }, [grafanaNotifiers, dispatch]);

  // transform receiver DTO to form values
  const [existingValue, id2original] = useMemo((): [
    ReceiverFormValues<GrafanaChannelValues> | undefined,
    Record<string, GrafanaManagedReceiverConfig>
  ] => {
    if (!existing || !grafanaNotifiers.result) {
      return [undefined, {}];
    }
    return grafanaReceiverToFormValues(existing, grafanaNotifiers.result!);
  }, [existing, grafanaNotifiers.result]);

  const [prefillValue] = useMemo(() => {
    if (!prefill || !grafanaNotifiers.result) {
      return [undefined, {}];
    }
    return grafanaReceiverToFormValues(prefill, grafanaNotifiers.result!);
  }, [prefill, grafanaNotifiers.result]);

  const onSubmit = async (values: ReceiverFormValues<GrafanaChannelValues>) => {
    const newReceiver = formValuesToGrafanaReceiver(values, id2original, defaultChannelValues);

    const onCallIntegrations = newReceiver.grafana_managed_receiver_configs?.filter((c) => c.type === 'oncall') ?? [];
    const autoOnCallIntegrations = onCallIntegrations.filter(
      (c) => c.settings['integration_type'] === 'new_oncall_integration'
    );

    const autoOnCallIntegrationsJobs = autoOnCallIntegrations.map(async (c) => {
      const newIntegration = await createIntegrationMutation({
        integration: 'grafana',
        verbal_name: c.settings['integration_name'],
      }).unwrap();
      c.type = 'webhook';
      c.settings['url'] = newIntegration.integration_url;
    });

    await Promise.all(autoOnCallIntegrationsJobs);

    const newConfig = updateConfigWithReceiver(config, newReceiver, existing?.name);
    dispatch(
      updateAlertManagerConfigAction({
        newConfig: newConfig,
        oldConfig: config,
        alertManagerSourceName: GRAFANA_RULES_SOURCE_NAME,
        successMessage: existing ? 'Contact point updated.' : 'Contact point created',
        redirectPath: '/alerting/notifications',
      })
    );
  };

  const onTestChannel = (values: GrafanaChannelValues) => {
    setTestChannelValues(values);
  };

  const testNotification = (alert?: TestReceiversAlert) => {
    if (testChannelValues) {
      const existing: GrafanaManagedReceiverConfig | undefined = id2original[testChannelValues.__id];
      const chan = formChannelValuesToGrafanaChannelConfig(testChannelValues, defaultChannelValues, 'test', existing);

      const payload = {
        alertManagerSourceName,
        receivers: [
          {
            name: 'test',
            grafana_managed_receiver_configs: [chan],
          },
        ],
        alert,
      };

      dispatch(testReceiversAction(payload));
    }
  };

  const takenReceiverNames = useMemo(
    () => config.alertmanager_config.receivers?.map(({ name }) => name).filter((name) => name !== existing?.name) ?? [],
    [config, existing]
  );

  // if any receivers in the contact point have a "provenance", the entire contact point should be readOnly
  const hasProvisionedItems = existing
    ? (existing.grafana_managed_receiver_configs ?? []).some((item) => Boolean(item.provenance))
    : false;

  // this basically checks if we can manage the selected alert manager data source, either because it's a Grafana Managed one
  // or a Mimir-based AlertManager
  const isManageableAlertManagerDataSource = !isVanillaPrometheusAlertManagerDataSource(alertManagerSourceName);

  const isEditable = isManageableAlertManagerDataSource && !hasProvisionedItems;
  const isTestable = isManageableAlertManagerDataSource || hasProvisionedItems;

  const onCallNotifier: NotifierDTO<NotifierType> = {
    name: 'Grafana OnCall',
    type: 'oncall',
    description: 'Grafana OnCall contact point',
    heading: 'OnCall heading',
    options: [
      option('integration_type', 'How to connect to OnCall', '', {
        required: true,
        element: 'radio',
        selectOptions: [
          {
            value: 'new_oncall_integration',
            label: 'New OnCall integration',
            description: 'A new OnCall integration without escalation chains will be automatically created',
          },
          {
            value: 'existing_oncall_integration',
            label: 'Existing OnCall integration',
            description: 'Use an existing OnCall integration',
          },
        ],
      }),
      option('integration_name', 'Integration name', 'The name of the new OnCall integration', {
        required: true,
        showWhen: { field: 'integration_type', is: 'new_oncall_integration' },
        // validationRule:
      }),
      option('url', 'URL', 'The endpoint to send HTTP POST requests to.', {
        required: true,
        showWhen: { field: 'integration_type', is: 'existing_oncall_integration' },
      }),
      option(
        'max_alerts',
        'Max alerts',
        'The maximum number of alerts to include in a single webhook message. Alerts above this threshold are truncated. When leaving this at its default value of 0, all alerts are included.',
        { placeholder: '0', validationRule: '(^\\d+$|^$)' }
      ),
    ],
  };

  const fieldValidators = {
    integration_name: (value: string) => {
      return onCallIntegrations.map((i) => i.verbal_name).includes(value)
        ? 'Integration of this name already exists in OnCall'
        : true;
    },
  };

  if (grafanaNotifiers.result) {
    const notifiers: Array<NotifierDTO<NotifierType>> = [...grafanaNotifiers.result, onCallNotifier];

    return (
      <>
        {hasProvisionedItems && <ProvisioningAlert resource={ProvisionedResource.ContactPoint} />}

        <ReceiverForm<GrafanaChannelValues>
          isEditable={isEditable}
          isTestable={isTestable}
          config={config}
          onSubmit={onSubmit}
          initialValues={existingValue ?? prefillValue}
          onTestChannel={onTestChannel}
          notifiers={notifiers}
          alertManagerSourceName={alertManagerSourceName}
          defaultItem={{ ...defaultChannelValues, type: 'oncall' }}
          takenReceiverNames={takenReceiverNames}
          commonSettingsComponent={GrafanaCommonChannelSettings}
          customValidators={fieldValidators}
        />
        <TestContactPointModal
          onDismiss={() => setTestChannelValues(undefined)}
          isOpen={!!testChannelValues}
          onTest={(alert) => testNotification(alert)}
        />
      </>
    );
  } else {
    return <LoadingPlaceholder text="Loading notifiers..." />;
  }
};
