import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import { UserRole } from '../../../generated/prisma/client';

export interface AuthenticatedUser {
  userId: string;
  email: string;
  role: UserRole;
}

export const CurrentUser = createParamDecorator(
  (_: unknown, ctx: ExecutionContext): AuthenticatedUser => {
    const request = ctx
      .switchToHttp()
      .getRequest<{ user: AuthenticatedUser }>();
    return request.user;
  },
);
