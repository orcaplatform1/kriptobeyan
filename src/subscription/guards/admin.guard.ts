import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import type { AuthenticatedUser } from '../../auth/decorators/current-user.decorator';

/**
 * Gerçek DB tabanlı admin kontrolü — `staff` tablosunda kaydı olan
 * kullanıcılar admin sayılır. Redeploy gerekmeden ekle/çıkar (birden fazla
 * kişi ödeme onaylayabilir, bkz. şema yorumu). İlk staff kaydı
 * `scripts/promote-staff.ts` ile eklenir (chicken-egg problemi: admin
 * paneli olmadan ilk admin'i kim ekleyecek — bkz. o script).
 */
@Injectable()
export class AdminGuard implements CanActivate {
  constructor(private readonly prisma: PrismaService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context
      .switchToHttp()
      .getRequest<{ user: AuthenticatedUser }>();
    if (!request.user?.userId) {
      throw new ForbiddenException('Bu işlem için admin yetkisi gerekli');
    }
    const staff = await this.prisma.staff.findUnique({
      where: { userId: request.user.userId },
    });
    if (!staff) {
      throw new ForbiddenException('Bu işlem için admin yetkisi gerekli');
    }
    return true;
  }
}
