{{- define "canvas.fullname" -}}
{{- if contains .Chart.Name .Release.Name -}}
{{- .Release.Name | trunc 50 | trimSuffix "-" -}}
{{- else -}}
{{- printf "%s-%s" .Release.Name .Chart.Name | trunc 50 | trimSuffix "-" -}}
{{- end -}}
{{- end -}}

{{- define "canvas.labels" -}}
app.kubernetes.io/name: {{ .Chart.Name }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version }}
{{- end -}}

{{/* Selector labels for one component: (list . "gateway") */}}
{{- define "canvas.selector" -}}
{{- $root := index . 0 -}}
app.kubernetes.io/name: {{ $root.Chart.Name }}
app.kubernetes.io/instance: {{ $root.Release.Name }}
app.kubernetes.io/component: {{ index . 1 }}
{{- end -}}

{{/* An image reference: (list . .Values.gateway.image) */}}
{{- define "canvas.image" -}}
{{- $root := index . 0 -}}
{{- $image := index . 1 -}}
{{- $ref := printf "%s/%s" $root.Values.image.registry $image.repository -}}
{{- if $image.digest -}}
{{- printf "%s@%s" $ref $image.digest -}}
{{- else -}}
{{- printf "%s:%s" $ref (default $root.Chart.AppVersion $root.Values.image.tag) -}}
{{- end -}}
{{- end -}}

{{- define "canvas.issuer" -}}
{{- if .Values.devIdp.enabled -}}{{ .Values.devIdp.issuer }}{{- else -}}{{ required "oidc.issuer is required" .Values.oidc.issuer }}{{- end -}}
{{- end -}}

{{- define "canvas.brokerSecret" -}}
{{- default (printf "%s-broker-credential" (include "canvas.fullname" .)) .Values.seed.brokerCredentialSecret -}}
{{- end -}}

{{- define "canvas.snapshotterSecret" -}}
{{- printf "%s-snapshotter-token" (include "canvas.fullname" .) -}}
{{- end -}}

{{/* Where a component finds Felix, under its variable prefix: (list . "GATEWAY") */}}
{{- define "canvas.felixEnv" -}}
{{- $root := index . 0 -}}
{{- $prefix := index . 1 -}}
{{- $v := $root.Values.felix -}}
- name: {{ $prefix }}_FELIX_BROKERS
  value: {{ join "," (required "felix.brokers is required" $v.brokers) | quote }}
- name: {{ $prefix }}_FELIX_SERVER_NAME
  value: {{ $v.serverName | quote }}
{{- if $v.caSecret.name }}
- name: {{ $prefix }}_FELIX_CA_FILE
  value: /etc/felix-canvas/ca/ca.crt
{{- end }}
- name: {{ $prefix }}_TENANT
  value: {{ $v.tenant | quote }}
- name: {{ $prefix }}_NAMESPACE
  value: {{ $v.namespace | quote }}
{{- end -}}

{{- define "canvas.caVolume" -}}
{{- if .Values.felix.caSecret.name }}
- name: ca
  secret:
    secretName: {{ .Values.felix.caSecret.name }}
    items:
      - key: {{ .Values.felix.caSecret.key }}
        path: ca.crt
{{- end }}
{{- end -}}

{{- define "canvas.caMount" -}}
{{- if .Values.felix.caSecret.name }}
- name: ca
  mountPath: /etc/felix-canvas/ca
  readOnly: true
{{- end }}
{{- end -}}

{{- define "canvas.securityContext" -}}
runAsNonRoot: true
runAsUser: 65532
runAsGroup: 65532
allowPrivilegeEscalation: false
readOnlyRootFilesystem: true
capabilities:
  drop: [ALL]
{{- end -}}
