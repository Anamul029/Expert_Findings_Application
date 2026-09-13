import { Controller, Get } from '@nestjs/common';
import { PricesService } from './prices.service';

@Controller({ path: 'prices', version: '1' })
export class PricesController {
  constructor(private readonly pricesService: PricesService) {}

  @Get()
  findAll() {
    return this.pricesService.findAll();
  }
}
