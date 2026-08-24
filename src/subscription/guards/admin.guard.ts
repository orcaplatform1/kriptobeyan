import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import type { AuthenticatedUser } from '../../auth/decorators/current-user.decorator';

/**
 * GEÇİCİ/BAŞLANGIÇ admin kontrolü: .env'deki ADMIN_EMAILS (virgülle ayrık)
 * listesindeki e-postalar admin sayılır. ORCA'daki gibi ayrı bir Staff/Admin
 * modeli ve girişi henüz yok — bu, gerçek bir admin paneli/rol sistemi
 * kurulana kadar kullanılacak pragmatik bir bootstrap. Manage panelinde
 * (plan fiyat/limit düzenleme) bu guard kullanılıyor.
 */
@Injectable()
export class AdminGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context
      .switchToHttp()
      .getRequest<{ user: AuthenticatedUser }>();
    const adminEmails = (process.env.ADMIN_EMAILS ?? '')
      .split(',')
      .map((e) => e.trim().toLowerCase())
      .filter(Boolean);
    if (
      !request.user?.email ||
      !adminEmails.includes(request.user.email.toLowerCase())
    ) {
      throw new ForbiddenException('Bu işlem için admin yetkisi gerekli');
    }
    return true;
  }
}
