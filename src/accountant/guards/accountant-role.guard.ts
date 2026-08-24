import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import type { AuthenticatedUser } from '../../auth/decorators/current-user.decorator';

@Injectable()
export class AccountantRoleGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context
      .switchToHttp()
      .getRequest<{ user: AuthenticatedUser }>();
    if (request.user?.role !== 'ACCOUNTANT') {
      throw new ForbiddenException(
        'Bu işlem sadece mali müşavir hesapları için geçerli',
      );
    }
    return true;
  }
}
