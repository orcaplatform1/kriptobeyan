import { Injectable } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { UserRole } from '../../../generated/prisma/client';
import { PrismaService } from '../../prisma/prisma.service';

export interface JwtPayload {
  sub: string;
  email: string;
  role: UserRole;
}

const LAST_SEEN_THROTTLE_MS = 60_000;

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(private readonly prisma: PrismaService) {
    const secret = process.env.JWT_SECRET;
    if (!secret) {
      throw new Error('JWT_SECRET tanimli degil (.env kontrol et)');
    }
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: secret,
    });
  }

  // Access token dogrulanirsa req.user buraya donen degeri alir.
  validate(payload: JwtPayload) {
    // Admin panelindeki "aktif kullanicilar" listesi icin — fire-and-forget,
    // istegi yavaslatmasin diye await edilmiyor. Tek sorguluk kosullu UPDATE
    // ile throttle edildigi icin (son 60sn icinde guncellenmisse atlanir)
    // her istekte ekstra bir OKUMA sorgusuna gerek yok.
    this.prisma.user
      .updateMany({
        where: {
          id: payload.sub,
          OR: [
            { lastSeenAt: null },
            { lastSeenAt: { lt: new Date(Date.now() - LAST_SEEN_THROTTLE_MS) } },
          ],
        },
        data: { lastSeenAt: new Date() },
      })
      .catch(() => {
        // sessizce yok say — presence takibi kritik yol degil
      });

    return { userId: payload.sub, email: payload.email, role: payload.role };
  }
}
