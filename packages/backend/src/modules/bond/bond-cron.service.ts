import { dateToTimestamp } from '@common/utils';
import { Metadata } from '@grpc/grpc-js';
import { tinkoff as TinkoffInstruments } from '@modules/tinkoff/protos/instruments';
import { tinkoff as TinkoffMarketData } from '@modules/tinkoff/protos/marketdata';
import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ClientGrpc } from '@nestjs/microservices';
import { Cron, CronExpression } from '@nestjs/schedule';
import { Bond, Coupon } from '@prisma/client';
import { firstValueFrom } from 'rxjs';

import { BondService } from './bond.service';
import { bondMapper } from './mappers/bond.mapper';
import { couponMapper } from './mappers/coupon.mapper';
import { lastPriceMapper } from './mappers/last-price.mapper';

const REQUEST_LIMIT = 50; // max requests per minute

@Injectable()
export class BondCronService {
  private readonly metadata = new Metadata();
  private readonly instrumentsService: TinkoffInstruments._public.invest.api.contract.v1.InstrumentsService;
  private readonly marketdataService: TinkoffMarketData._public.invest.api.contract.v1.MarketDataService;

  constructor(
    @Inject('INSTRUMENTS_CLIENT') private readonly instrumentsClient: ClientGrpc,
    @Inject('MARKETDATA_CLIENT') private readonly marketdataClient: ClientGrpc,
    private readonly configService: ConfigService,
    private readonly bondService: BondService
  ) {
    this.metadata.add('authorization', `Bearer ${this.configService.get('TINKOFF_TOKEN')}`);
    this.instrumentsService =
      this.instrumentsClient.getService<TinkoffInstruments._public.invest.api.contract.v1.InstrumentsService>(
        'InstrumentsService'
      );
    this.marketdataService =
      this.marketdataClient.getService<TinkoffMarketData._public.invest.api.contract.v1.MarketDataService>(
        'MarketDataService'
      );
  }

  @Cron('0 2 * * *', { timeZone: 'Europe/Moscow' })
  public async updateBonds() {
    console.log('Updating bonds...');
    const bonds = await this.getBonds();

    console.log(`Updating ${bonds.length} bonds...`);

    await this.bondService.updateOrInsertBonds(bonds);

    console.log('Updating coupons...');

    const coupons = await this.getCoupons(bonds);

    console.log(`Updating ${coupons.length} coupons...`);

    await this.bondService.updateCoupons(coupons);

    console.log('Bonds updated');
  }

  @Cron(CronExpression.EVERY_10_MINUTES)
  public async updateBondPrices() {
    const bonds = await this.getBonds();

    const response = await firstValueFrom(
      this.marketdataService.getLastPrices(
        {
          instrumentId: bonds.map((bond) => bond.uid).filter((uid) => !!uid),
        },
        this.metadata
      )
    );

    const convertedLastPrices = response.lastPrices?.map((lastPrice) => lastPriceMapper(lastPrice)) ?? [];

    await this.bondService.updatePrices(convertedLastPrices);
  }

  private async getBonds(): Promise<Omit<Bond, 'id'>[]> {
    const response = await firstValueFrom(
      this.instrumentsService.bonds(
        {
          instrumentStatus:
            TinkoffInstruments._public.invest.api.contract.v1.InstrumentStatus.INSTRUMENT_STATUS_BASE,
          instrumentExchange:
            TinkoffInstruments._public.invest.api.contract.v1.InstrumentExchangeType
              .INSTRUMENT_EXCHANGE_UNSPECIFIED,
        },
        this.metadata
      )
    );

    return response.instruments?.map((bond) => bondMapper(bond)) ?? [];
  }

  private async getCoupons(bonds: Omit<Bond, 'id'>[]): Promise<{ uid: string; coupons: Coupon[] }[]> {
    const filteredBonds = bonds.filter((bond) => !!bond.figi && !!bond.maturityDate);

    const timePerRequest = 60 / REQUEST_LIMIT;
    let startTime: Date;

    const result: { uid: string; coupons: Coupon[] }[] = [];
    for (const bond of filteredBonds) {
      startTime = new Date();
      console.log(`Fetching coupons for ${bond.name}...`);
      const response = await firstValueFrom(
        this.instrumentsService.getBondCoupons(
          {
            figi: bond.figi!,
            from: dateToTimestamp(new Date()),
            to: dateToTimestamp(bond.maturityDate!),
          },
          this.metadata
        )
      );
      const coupons = response.events?.map((coupon) => couponMapper(coupon)) ?? [];

      result.push({ uid: bond.uid, coupons });

      const timeout = timePerRequest - (new Date().getTime() - startTime.getTime()) / 1000;

      await new Promise((resolve) => setTimeout(resolve, (timeout < 0 ? 0 : timeout) * 1000));
    }

    return result;
  }
}
