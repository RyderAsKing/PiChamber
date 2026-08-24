export const MAX_EXTENSION_APP_HTML_CHARS = 200_000;
const MAX_EXTENSION_FORM_FIELDS = 12;
const MAX_EXTENSION_FORM_OPTIONS = 20;

const FORM_FIELD_TYPES = new Set(['text', 'textarea', 'number', 'select', 'checkbox']);

/**
 * Normalize extension-authored form descriptors at both sides of the private
 * daemon IPC seam. Keeping this in one module prevents the daemon bridge and
 * public route projection from accepting different field shapes.
 */
export const sanitizeExtensionFormFields = (fields) => {
  if (!Array.isArray(fields)) return [];
  return fields.slice(0, MAX_EXTENSION_FORM_FIELDS).flatMap((field) => {
    if (!field || typeof field !== 'object') return [];
    const id = typeof field.id === 'string' ? field.id.slice(0, 128) : '';
    const label = typeof field.label === 'string' ? field.label.slice(0, 256) : '';
    if (!id || !label) return [];
    return [{
      id,
      label,
      type: FORM_FIELD_TYPES.has(field.type) ? field.type : 'text',
      ...(field.required === true ? { required: true } : {}),
      ...(typeof field.placeholder === 'string' ? { placeholder: field.placeholder.slice(0, 256) } : {}),
      ...(Array.isArray(field.options)
        ? {
            options: field.options
              .filter((option) => typeof option === 'string')
              .map((option) => option.slice(0, 256))
              .slice(0, MAX_EXTENSION_FORM_OPTIONS),
          }
        : {}),
      ...(typeof field.initial === 'string' ? { initial: field.initial.slice(0, 2_000) } : {}),
      ...(Number.isFinite(field.min) ? { min: field.min } : {}),
      ...(Number.isFinite(field.max) ? { max: field.max } : {}),
    }];
  });
};

/** Validate a form answer against the exact descriptor sent to the client. */
export const validateExtensionFormValues = (fields, values) => {
  if (!Array.isArray(fields) || !values || typeof values !== 'object' || Array.isArray(values)) return false;
  const fieldsById = new Map(fields.map((field) => [field.id, field]));
  for (const key of Object.keys(values)) if (!fieldsById.has(key)) return false;
  for (const field of fields) {
    const value = values[field.id];
    if (field.required === true && (typeof value !== 'string' || value.length === 0)) return false;
    if (value === undefined || value.length === 0) continue;
    if (typeof value !== 'string') return false;
    if (field.type === 'number') {
      const number = Number(value);
      if (!Number.isFinite(number)) return false;
      if (typeof field.min === 'number' && number < field.min) return false;
      if (typeof field.max === 'number' && number > field.max) return false;
    } else if (field.type === 'select' && !field.options?.includes(value)) {
      return false;
    } else if (field.type === 'checkbox' && value !== 'true' && value !== 'false') {
      return false;
    }
  }
  return true;
};
