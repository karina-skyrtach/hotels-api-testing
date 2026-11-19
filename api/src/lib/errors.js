// Одна помилка API = статус + код + повідомлення + деталі.
// Будь-де в коді можна написати `throw new ApiError(...)`,
// і сервер сам перетворить її на JSON-відповідь єдиного формату.
export class ApiError extends Error {
  constructor(status, error, message, details = []) {
    super(message);
    this.status = status;
    this.error = error;
    this.details = details;
  }
}

export const validationError = (details) =>
  new ApiError(400, 'VALIDATION_ERROR', 'Request validation failed', details);

export const notFound = (what = 'Resource') =>
  new ApiError(404, 'NOT_FOUND', `${what} not found`);

export const referenceNotFound = (details) =>
  new ApiError(422, 'REFERENCE_NOT_FOUND', 'Referenced record does not exist', details);

export const conflict = (error, message) => new ApiError(409, error, message);
