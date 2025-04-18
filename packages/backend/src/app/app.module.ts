import { BondModule } from '@modules/bond/bond.module';
import { BotModule } from '@modules/bot/bot.module';
import { TinkoffModule } from '@modules/tinkoff/tinkoff.module';
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';

@Module({
  imports: [
    ConfigModule.forRoot({
      envFilePath: `.env.${process.env.NODE_ENV || 'local'}`,
      isGlobal: true,
    }),
    ScheduleModule.forRoot(),
    BotModule,
    BondModule,
    TinkoffModule,
  ],
})
export class AppModule {}
